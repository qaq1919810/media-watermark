// 水印核心（OOP）：基于 Adobe TrustMark（Q 变体）的隐形水印。
//
//   const watermark = new Watermark({modelFile, decoderFile, detectorFile, wmStrength, threads, modelMode, detectThreshold})
//   await watermark.add({input, watermarkContent, mode, watermarkPosition, outputPath, outputFormat})  // 嵌入
//   await watermark.check({input})                                                                     // 检测
//
// input 支持两种形式：图片路径字符串，或内存原始像素 {data, width, height, channels?}。
//
// 嵌入（add）：整图（长宽比 > 2 时取中心正方形）→ 缩放 256×256 → ONNX 编码器出 stego
//        → 残差 = stego - cover → 去掉逐通道均值（消除色偏）→ 双线性放大回区域尺寸
//        → 原图 + 残差 × 强度 → 输出（Alpha 通道保持原样）。
// 检测（check）：整图缩放到最长边 ≤1600 → ONNX 检测器定位水印区域（框 + 置信度）
//        → 逐个区域裁剪、解码（无需预先知道水印的位置/大小）。
//
// 100 位载荷由本工具自行组织（magic "WM" + 长度 + 内容 + CRC8），与官方 BCH schema 无关。
import {cpus} from 'node:os'
import {pathToFileURL} from 'node:url'
import {applicationFile, resolvePath} from '#utils/paths.mjs'
import {readImage, resizeImageRGB, resizeRawRGB, resizeToRGB, saveImage} from '#utils/image.mjs'

const ENCODE_RESOLUTION = 256 // 编码器输入分辨率（官方）
const DECODE_RESOLUTION = 256 // 解码器输入分辨率（Q 变体，官方 JS 配置为 256）
const ASPECT_RATIO_LIMIT = 2 // 长宽比超过此值时只处理中心正方形区域（官方 Q 行为）
const MIN_SHORT_SIDE = 150 // 官方支持的最小短边
const BITS = 100
const PAYLOAD_BYTES = 12
const CONTENT_BITS = 64 // 内容区 64 位（8 字节）
const MAGIC_0 = 0x57 // 'W'
const MAGIC_1 = 0x4d // 'M'
// 水印内容三种模式：ascii（每字符 7 位）/ utf8（每字节 8 位）/ bits（原始位）
const MODE_CODES = {ascii: 0, utf8: 1, bits: 2}
const MODE_NAMES = ['ascii', 'utf8', 'bits']
const ASCII_BITS = 7
const MAX_ASCII_CHARS = Math.floor(CONTENT_BITS / ASCII_BITS) // 9
const MAX_UTF8_BYTES = CONTENT_BITS / 8 // 8
const MAX_RAW_BITS = 63 // 位模式：长度字段 6 位，最多 63
const DEFAULT_MODEL = 'model/encoder_Q.onnx'
const DEFAULT_DECODER = 'model/decoder_Q.onnx'
const DEFAULT_DETECTOR = 'model/detector_Q.onnx'
const DEFAULT_STRENGTH = 0.8 // 本工具默认 0.8（官方默认 1.0）
const STRENGTH_RANGE = [0.7, 1.5] // 官方推荐范围：0.7~0.8 低噪声场景可靠；1.5 可抗打印
const DEFAULT_MODEL_MODE = ['dml', 'cpu'] // 运行模式：按序优先，不可用自动下退
const DETECT_MAX_EDGE = 1600 // 检测器输入的最长边上限（官方 model_resolution_max_detect）
const DEFAULT_DETECT_THRESHOLD = 0.5 // 盲扫时丢弃置信度低于此值的候选框

// ---- 加载 onnxruntime（开发/编译双模式）----
const loadOrt = async () => {
    const ortFile = Bun.isStandaloneExecutable
        ? applicationFile('runtime', 'onnxruntime-node', 'js', 'ort.cjs')
        : applicationFile('node_modules', 'onnxruntime-node', 'dist', 'index.js')
    if (!(await Bun.file(ortFile).exists())) {
        const hint = Bun.isStandaloneExecutable
            ? '请确认 exe 旁有 runtime/onnxruntime-node 目录（可用 bun run build 生成）'
            : '请先执行 bun install'
        throw new Error(`找不到 onnxruntime 运行文件：${ortFile}（${hint}）`)
    }
    const module = await import(pathToFileURL(ortFile).href)
    return module.default ?? module
}

// 线程数："full" 交给 onnxruntime 默认；数字须为 1~本机逻辑核心数的整数，超出直接报错。
const resolveThreads = (threads) => {
    if (threads === undefined || threads === 'full') return {}
    const count = Number(threads)
    if (!Number.isInteger(count) || count < 1) {
        throw new Error(`threads 必须是 "full" 或正整数，当前为：${threads}`)
    }
    const maximum = cpus().length
    if (count > maximum) {
        throw new Error(`threads=${count} 超出本机支持的线程数（最大 ${maximum}）`)
    }
    return {intraOpNumThreads: count}
}

// 运行模式（executionProviders）：数组按序优先；不可用的执行提供器由 onnxruntime 自动跳过并下退。
const resolveModelMode = (modelMode) => {
    const list = Array.isArray(modelMode) && modelMode.length > 0 ? modelMode : DEFAULT_MODEL_MODE
    if (!list.every((name) => typeof name === 'string' && name.length > 0)) {
        throw new Error('modelMode 必须是字符串数组，例如 ["dml", "cpu"]')
    }
    return [...list]
}

// 水印强度：默认 0.8；超出官方推荐范围时提示但继续。
const resolveStrength = (value) => {
    const strength = value === undefined || value === null || value === '' ? DEFAULT_STRENGTH : Number(value)
    if (!Number.isFinite(strength) || strength <= 0) {
        throw new Error(`wmStrength 必须是正数，当前为：${value}`)
    }
    if (strength < STRENGTH_RANGE[0] || strength > STRENGTH_RANGE[1]) {
        console.warn(`提示：wmStrength=${strength} 超出官方推荐范围 ${STRENGTH_RANGE[0]}~${STRENGTH_RANGE[1]}（0.7~0.8 低噪声可靠；1.5 抗打印），继续执行`)
    }
    return strength
}

// ---- 载荷：magic + 长度 + 内容（8 字节）+ CRC8（96 位）+ 4 位折叠校验 = 100 位 ----
// 字节级校验：CRC8（多项式 0x07，初值 0）。
const crc8 = (bytes) => {
    let crc = 0
    for (const byte of bytes) {
        crc ^= byte
        for (let i = 0; i < 8; i++) {
            crc = ((crc & 0x80 ? (crc << 1) ^ 0x07 : crc << 1) & 0xff)
        }
    }
    return crc
}

// 内容 -> 100 bit 载荷。
// 结构：magic(16) + 模式(2) + 长度(6) + 内容(64) + CRC8(8) = 96 位，+ 4 位折叠校验 = 100 位。
const encodePayload = (content, mode = 'utf8') => {
    const modeCode = MODE_CODES[mode]
    if (modeCode === undefined) {
        throw new Error(`未知水印模式：${mode}（可用：ascii / utf8 / bits）`)
    }
    let bitString
    let length
    if (mode === 'bits') {
        bitString = String(content).replace(/\s+/g, '')
        if (bitString.length === 0) throw new Error('位模式的内容不能为空')
        if (!/^[01]+$/.test(bitString)) throw new Error('位模式的内容只能是 0 和 1')
        if (bitString.length > MAX_RAW_BITS) throw new Error(`位模式最多 ${MAX_RAW_BITS} 位，当前 ${bitString.length} 位`)
        length = bitString.length
    } else if (mode === 'ascii') {
        const chars = [...String(content)]
        if (chars.length === 0) throw new Error('ASCII 模式的内容不能为空')
        if (chars.length > MAX_ASCII_CHARS) throw new Error(`ASCII 模式最多 ${MAX_ASCII_CHARS} 个字符，当前 ${chars.length} 个`)
        for (const char of chars) {
            if (char.codePointAt(0) > 127) throw new Error(`ASCII 模式只支持 ASCII 字符（0-127），"${char}" 超出范围`)
        }
        length = chars.length
        bitString = chars.map((char) => char.codePointAt(0).toString(2).padStart(ASCII_BITS, '0')).join('')
    } else {
        const bytes = Buffer.from(String(content), 'utf8')
        if (bytes.length === 0) throw new Error('UTF-8 模式的内容不能为空')
        if (bytes.length > MAX_UTF8_BYTES) throw new Error(`UTF-8 模式最多 ${MAX_UTF8_BYTES} 字节，当前 ${bytes.length} 字节`)
        length = bytes.length
        bitString = [...bytes].map((byte) => byte.toString(2).padStart(8, '0')).join('')
    }

    const payload = Buffer.alloc(PAYLOAD_BYTES)
    payload[0] = MAGIC_0
    payload[1] = MAGIC_1
    payload[2] = (modeCode << 6) | (length & 0x3f)
    for (let i = 0; i < bitString.length; i++) {
        if (bitString[i] === '1') payload[3 + (i >> 3)] |= 0x80 >> (i & 7)
    }
    payload[PAYLOAD_BYTES - 1] = crc8(payload.subarray(0, PAYLOAD_BYTES - 1))

    let folded = 0
    for (const byte of payload) folded ^= (byte >> 4) ^ (byte & 0x0f)

    const bits = new Float32Array(BITS)
    for (let i = 0; i < PAYLOAD_BYTES; i++) {
        for (let b = 0; b < 8; b++) bits[i * 8 + b] = (payload[i] >> (7 - b)) & 1
    }
    for (let b = 0; b < 4; b++) bits[96 + b] = ((folded & 0x0f) >> (3 - b)) & 1
    return bits
}

// 100 bit -> {content, mode}：先直接校验；失败则穷举翻转候选位纠错（纯算术）。
// 误码通常落在"置信度最低"（|logit| 最小）的位上：
//   单比特全量 → 低置信度组合翻转 2/3/4 位 → 兜底全量三比特组合（保证任意 3 位误码可纠）。
const decodePayload = (scores, strict = false) => {
    // 解码器输出是 logits（非概率），以 0 为判定边界
    const bits = new Uint8Array(BITS)
    for (let i = 0; i < BITS; i++) bits[i] = scores[i] > 0 ? 1 : 0

    // 复用同一块内存（顺序调用，无并发）
    const payload = Buffer.alloc(PAYLOAD_BYTES)
    const read = () => {
        for (let i = 0; i < PAYLOAD_BYTES; i++) {
            let byte = 0
            for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i * 8 + b]
            payload[i] = byte
        }
        let folded = 0
        for (const byte of payload) folded ^= (byte >> 4) ^ (byte & 0x0f)
        let checksum = 0
        for (let b = 0; b < 4; b++) checksum = (checksum << 1) | bits[96 + b]
        if (payload[0] !== MAGIC_0 || payload[1] !== MAGIC_1) return null
        if (payload[PAYLOAD_BYTES - 1] !== crc8(payload.subarray(0, PAYLOAD_BYTES - 1))) return null
        if (checksum !== (folded & 0x0f)) return null

        const mode = MODE_NAMES[payload[2] >> 6]
        const length = payload[2] & 0x3f
        let bitString = ''
        for (let i = 0; i < CONTENT_BITS; i++) bitString += (payload[3 + (i >> 3)] >> (7 - (i & 7))) & 1
        if (mode === 'bits') {
            return length > 0 && length <= MAX_RAW_BITS ? {content: bitString.slice(0, length), mode} : null
        }
        if (mode === 'ascii') {
            if (length === 0 || length > MAX_ASCII_CHARS) return null
            let text = ''
            for (let i = 0; i < length; i++) {
                text += String.fromCodePoint(parseInt(bitString.slice(i * ASCII_BITS, (i + 1) * ASCII_BITS), 2))
            }
            return {content: text, mode}
        }
        if (length === 0 || length > MAX_UTF8_BYTES) return null
        const bytes = []
        for (let i = 0; i < length; i++) bytes.push(parseInt(bitString.slice(i * 8, (i + 1) * 8), 2))
        return {content: Buffer.from(bytes).toString('utf8'), mode}
    }

    const direct = read()
    if (direct !== null) return direct

    // 置信度排序：|logit| 越小越可能是误码
    const order = Array.from({length: BITS}, (_, i) => i).sort(
        (a, b) => Math.abs(scores[a]) - Math.abs(scores[b])
    )

    // 单比特：全量尝试
    for (const i of order) {
        bits[i] ^= 1
        const decoded = read()
        bits[i] ^= 1
        if (decoded !== null) return decoded
    }

    // 组合翻转：在低置信度候选内穷举 count 位
    const flipCombos = (candidates, count) => {
        const chosen = []
        const walk = (start) => {
            if (chosen.length === count) {
                for (const i of chosen) bits[i] ^= 1
                const decoded = read()
                for (const i of chosen) bits[i] ^= 1
                return decoded
            }
            for (let i = start; i < candidates.length; i++) {
                chosen.push(candidates[i])
                const decoded = walk(i + 1)
                chosen.pop()
                if (decoded !== null) return decoded
            }
            return null
        }
        return walk(0)
    }
    // scan 用严格模式：只做单/双比特纠错，避免对"半水印"裁剪产生误判
    if (strict) return flipCombos(order.slice(0, 24), 2)

    for (const [count, size] of [[2, 24], [4, 20], [3, 32]]) {
        const decoded = flipCombos(order.slice(0, size), count)
        if (decoded !== null) return decoded
    }

    // 兜底：全量三比特组合（无置信度假设，保证任意 3 位误码可纠）
    for (let i = 0; i < BITS - 2; i++) {
        bits[i] ^= 1
        for (let j = i + 1; j < BITS - 1; j++) {
            bits[j] ^= 1
            for (let k = j + 1; k < BITS; k++) {
                bits[k] ^= 1
                const decoded = read()
                bits[k] ^= 1
                if (decoded !== null) {
                    bits[j] ^= 1
                    bits[i] ^= 1
                    return decoded
                }
            }
            bits[j] ^= 1
        }
        bits[i] ^= 1
    }
    return null
}

// ---- 张量与小工具 ----
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

// RGB -> NCHW 浮点张量（归一化到 [-1,1]）；支持任意宽高
const toNCHW = (rgb, width, height) => {
    const out = new Float32Array(3 * width * height)
    const plane = width * height
    for (let i = 0; i < plane; i++) {
        out[i] = (rgb[i * 3] / 255) * 2 - 1
        out[plane + i] = (rgb[i * 3 + 1] / 255) * 2 - 1
        out[2 * plane + i] = (rgb[i * 3 + 2] / 255) * 2 - 1
    }
    return out
}

// 双线性放大（planar [3][sh][sw] → [3][dh][dw]，align_corners=false，与 torch interpolate 一致）
const upsamplePlanar = (src, sw, sh, dw, dh) => {
    const out = new Float32Array(3 * dw * dh)
    const scaleX = sw / dw
    const scaleY = sh / dh
    for (let c = 0; c < 3; c++) {
        const sourceOffset = c * sw * sh
        const targetOffset = c * dw * dh
        for (let y = 0; y < dh; y++) {
            const sy = clamp((y + 0.5) * scaleY - 0.5, 0, sh - 1)
            const y0 = Math.floor(sy)
            const y1 = Math.min(y0 + 1, sh - 1)
            const fy = sy - y0
            for (let x = 0; x < dw; x++) {
                const sx = clamp((x + 0.5) * scaleX - 0.5, 0, sw - 1)
                const x0 = Math.floor(sx)
                const x1 = Math.min(x0 + 1, sw - 1)
                const fx = sx - x0
                const p00 = src[sourceOffset + y0 * sw + x0]
                const p01 = src[sourceOffset + y0 * sw + x1]
                const p10 = src[sourceOffset + y1 * sw + x0]
                const p11 = src[sourceOffset + y1 * sw + x1]
                out[targetOffset + y * dw + x] = (p00 * (1 - fx) + p01 * fx) * (1 - fy) + (p10 * (1 - fx) + p11 * fx) * fy
            }
        }
    }
    return out
}

// 处理区域：长宽比 ≤ 2 用整图；超过时取中心正方形（与官方一致）。
const processingRegion = (width, height) => {
    const ratio = Math.max(width, height) / Math.min(width, height)
    if (ratio <= ASPECT_RATIO_LIMIT) return {left: 0, top: 0, width, height}
    const side = Math.min(width, height)
    return {left: Math.floor((width - side) / 2), top: Math.floor((height - side) / 2), width: side, height: side}
}

// 尺寸校验：官方支持约 150 像素起。
const ensureSupportedSize = (image) => {
    const shortSide = Math.min(image.width, image.height)
    if (shortSide < MIN_SHORT_SIDE) {
        throw new Error(`图片过小：最短边需 ≥ ${MIN_SHORT_SIDE} 像素（当前 ${image.width}×${image.height}）`)
    }
}

// 加载编码器/解码器/检测器会话（带缓存：同一模型+配置只建一次，Web 服务多请求时复用）。
const sessionCache = new Map()
const loadSession = async ({file, fallback, label, threads, modelMode}) => {
    const ort = await loadOrt()
    const path = resolvePath(file ?? fallback)
    if (!(await Bun.file(path).exists())) {
        throw new Error(`${label}模型不存在：${path}`)
    }
    const options = {executionProviders: resolveModelMode(modelMode), ...resolveThreads(threads)}
    const key = `${path}|${options.executionProviders.join(',')}|${options.intraOpNumThreads ?? 'auto'}`
    if (!sessionCache.has(key)) {
        const creating = ort.InferenceSession.create(path, options).catch((error) => {
            sessionCache.delete(key)
            throw error
        })
        sessionCache.set(key, creating)
    }
    return {ort, session: await sessionCache.get(key)}
}

// 编码器推理（自动识别输入名："图像"与"秘密"；猜反时交换重试一次）
const runEncoder = async (ort, session, cover, bits) => {
    const names = [...session.inputNames]
    const imageName = names.find((name) => /concat|image|cover|img/i.test(name)) ?? names[0]
    const secretName = names.find((name) => /gemm|secret|message|payload/i.test(name)) ?? names[1]
    const feed = (imageKey, secretKey) => ({
        [imageKey]: new ort.Tensor('float32', cover, [1, 3, ENCODE_RESOLUTION, ENCODE_RESOLUTION]),
        [secretKey]: new ort.Tensor('float32', Float32Array.from(bits), [1, BITS])
    })
    try {
        const result = await session.run(feed(imageName, secretName))
        return result[session.outputNames[0]].data
    } catch {
        const result = await session.run(feed(secretName, imageName))
        return result[session.outputNames[0]].data
    }
}

// 解码器推理（输出 100 位 logits）
const runDecoder = async (ort, session, small) => {
    const inputName = [...session.inputNames].find((name) => /image|input/i.test(name)) ?? session.inputNames[0]
    const result = await session.run({
        [inputName]: new ort.Tensor('float32', toNCHW(small, DECODE_RESOLUTION, DECODE_RESOLUTION), [1, 3, DECODE_RESOLUTION, DECODE_RESOLUTION])
    })
    return result[session.outputNames[0]].data
}

// 把区域处理结果合并为 RGB 像素（残差 × 强度 + 原像素）
const mergeRegion = (image, region, residual, strength) => {
    const merged = Buffer.alloc(region.width * region.height * 3)
    const plane = region.width * region.height
    for (let y = 0; y < region.height; y++) {
        for (let x = 0; x < region.width; x++) {
            const index = y * region.width + x
            const sourceIndex = ((region.top + y) * image.width + region.left + x) * 4
            for (let c = 0; c < 3; c++) {
                const value = residual[c * plane + index] * strength + (image.data[sourceIndex + c] / 127.5 - 1)
                merged[index * 3 + c] = Math.round(clamp(value, -1, 1) * 127.5 + 127.5)
            }
        }
    }
    return merged
}

// 把区域结果贴回整图（始终返回 RGBA 数据，Alpha 通道保持原样）；区域不占满整图时边缘做羽化（与官方 feather_paste 一致）。
const pasteRegion = (image, region, merged) => {
    const width = image.width
    const {left, top, width: regionWidth, height: regionHeight} = region
    const out = Buffer.from(image.data)
    for (let y = 0; y < regionHeight; y++) {
        for (let x = 0; x < regionWidth; x++) {
            const sourceIndex = (y * regionWidth + x) * 3
            const targetIndex = ((top + y) * width + left + x) * 4
            out[targetIndex] = merged[sourceIndex]
            out[targetIndex + 1] = merged[sourceIndex + 1]
            out[targetIndex + 2] = merged[sourceIndex + 2]
        }
    }
    if (left === 0 && top === 0 && regionWidth === width && regionHeight === image.height) return out
    const feather = Math.min(50, Math.max(1, Math.round(Math.min(regionWidth, regionHeight) * 0.01)))
    for (let i = 0; i < feather; i++) {
        const alpha = (i + 1) / feather
        for (const [destinationRow, sourceRow] of [
            [top + i, i],
            [top + regionHeight - 1 - i, regionHeight - 1 - i]
        ]) {
            for (let x = 0; x < regionWidth; x++) {
                for (let c = 0; c < 3; c++) {
                    const wmValue = merged[(sourceRow * regionWidth + x) * 3 + c]
                    const coverValue = image.data[(destinationRow * width + left + x) * 4 + c]
                    out[(destinationRow * width + left + x) * 4 + c] = Math.round(alpha * wmValue + (1 - alpha) * coverValue)
                }
            }
        }
        for (const [destinationColumn, sourceColumn] of [
            [left + i, i],
            [left + regionWidth - 1 - i, regionWidth - 1 - i]
        ]) {
            for (let y = 0; y < regionHeight; y++) {
                for (let c = 0; c < 3; c++) {
                    const wmValue = merged[(y * regionWidth + sourceColumn) * 3 + c]
                    const coverValue = image.data[((top + y) * width + destinationColumn) * 4 + c]
                    out[((top + y) * width + destinationColumn) * 4 + c] = Math.round(alpha * wmValue + (1 - alpha) * coverValue)
                }
            }
        }
    }
    return out
}

// PSNR（只统计 RGB 通道）
const psnr = (pixels, source, width, height) => {
    let mse = 0
    for (let i = 0; i < width * height; i++) {
        for (let c = 0; c < 3; c++) {
            const d = pixels[i * 4 + c] - source[i * 4 + c]
            mse += d * d
        }
    }
    mse /= width * height * 3
    return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse)
}

// 去掉 Alpha 通道（原图不带 Alpha 时输出 RGB）
const stripAlpha = (rgba, width, height) => {
    const rgb = Buffer.alloc(width * height * 3)
    for (let i = 0; i < width * height; i++) {
        rgb[i * 3] = rgba[i * 4]
        rgb[i * 3 + 1] = rgba[i * 4 + 1]
        rgb[i * 3 + 2] = rgba[i * 4 + 2]
    }
    return rgb
}

// 从整图 RGBA 中裁出一个区域的 RGB 像素。
const cropRGB = (image, region) => {
    const out = Buffer.alloc(region.width * region.height * 3)
    for (let y = 0; y < region.height; y++) {
        for (let x = 0; x < region.width; x++) {
            const source = ((region.top + y) * image.width + region.left + x) * 4
            const target = (y * region.width + x) * 3
            out[target] = image.data[source]
            out[target + 1] = image.data[source + 1]
            out[target + 2] = image.data[source + 2]
        }
    }
    return out
}

// 残差 = clamp(stego) - cover，并去掉逐通道均值（消除色偏）。
const computeResidual = (cover, stego) => {
    const residual = new Float32Array(3 * ENCODE_RESOLUTION * ENCODE_RESOLUTION)
    for (let c = 0; c < 3; c++) {
        const offset = c * ENCODE_RESOLUTION * ENCODE_RESOLUTION
        let sum = 0
        for (let i = 0; i < ENCODE_RESOLUTION * ENCODE_RESOLUTION; i++) {
            residual[offset + i] = clamp(stego[offset + i], -1, 1) - cover[offset + i]
            sum += residual[offset + i]
        }
        const mean = sum / (ENCODE_RESOLUTION * ENCODE_RESOLUTION)
        for (let i = 0; i < ENCODE_RESOLUTION * ENCODE_RESOLUTION; i++) residual[offset + i] -= mean
    }
    return residual
}

// 把一个水印嵌入指定区域（就地修改 image.data）；区域覆盖整图时即"整图嵌入"。
const embedRegion = async (ort, session, image, region, bits, strength) => {
    const rgb = cropRGB(image, region)
    const small = await resizeRawRGB(rgb, region.width, region.height, ENCODE_RESOLUTION, ENCODE_RESOLUTION)
    const cover = toNCHW(small, ENCODE_RESOLUTION, ENCODE_RESOLUTION)
    const stego = await runEncoder(ort, session, cover, bits)
    const residual = computeResidual(cover, stego)
    const resized = upsamplePlanar(residual, ENCODE_RESOLUTION, ENCODE_RESOLUTION, region.width, region.height)
    const merged = mergeRegion(image, region, resized, strength)
    image.data = pasteRegion(image, region, merged)
}

// 两个矩形是否重叠。
const overlaps = (a, b) =>
    a.left < b.left + b.width && b.left < a.left + a.width &&
    a.top < b.top + b.height && b.top < a.top + a.height

// 解析并校验水印区域：[[{x,y},{x,y}], ...]。
// 要求：矩形（长宽比 ≤2:1）、短边 ≥150、全部在图片内、互不重叠。
const parsePositions = (positions, image) => {
    if (!Array.isArray(positions) || positions.length === 0) {
        throw new Error('watermarkPosition 必须是非空数组')
    }
    const regions = positions.map((pair, index) => {
        if (!Array.isArray(pair) || pair.length !== 2) {
            throw new Error(`第 ${index + 1} 个水印区域必须包含两个点：[{x,y},{x,y}]`)
        }
        const [first, second] = pair
        const x1 = Math.round(Number(first?.x))
        const y1 = Math.round(Number(first?.y))
        const x2 = Math.round(Number(second?.x))
        const y2 = Math.round(Number(second?.y))
        if (![x1, y1, x2, y2].every(Number.isFinite)) {
            throw new Error(`第 ${index + 1} 个水印区域的坐标无效`)
        }
        return {left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1)}
    })
    for (const [index, region] of regions.entries()) {
        const shortSide = Math.min(region.width, region.height)
        const longSide = Math.max(region.width, region.height)
        if (shortSide < MIN_SHORT_SIDE) {
            throw new Error(`第 ${index + 1} 个水印区域过小：短边需 ≥ ${MIN_SHORT_SIDE}（当前 ${region.width}×${region.height}）`)
        }
        if (longSide > shortSide * 2) {
            throw new Error(`第 ${index + 1} 个水印区域长宽比超过 2:1（当前 ${region.width}×${region.height}）`)
        }
        if (region.left < 0 || region.top < 0 || region.left + region.width > image.width || region.top + region.height > image.height) {
            throw new Error(`第 ${index + 1} 个水印区域超出图片范围（图片 ${image.width}×${image.height}）`)
        }
    }
    for (let i = 0; i < regions.length; i++) {
        for (let j = i + 1; j < regions.length; j++) {
            if (overlaps(regions[i], regions[j])) {
                throw new Error(`第 ${i + 1} 个和第 ${j + 1} 个水印区域重叠`)
            }
        }
    }
    return regions
}

// 嵌入（内部实现）：给定 positions 时逐个区域内嵌；否则整图一次编码（长宽比 >2 取中心正方形）。
// inputPath 可以是路径字符串，也可以是内存像素 {data, width, height, channels?}。
const addWatermark = async ({inputPath, outputPath, watermarkContent, outputFormat, modelFile, wmStrength, threads, modelMode, positions, mode}) => {
    if (!inputPath) throw new Error('add 需要输入图片：input（路径或 {data,width,height,channels?} 内存像素）')
    if (!outputPath) throw new Error('add 需要输出图片：outputPath')
    if (!watermarkContent) throw new Error('add 需要水印内容：watermarkContent')

    const strength = resolveStrength(wmStrength)
    const bits = encodePayload(watermarkContent, mode)
    const imageInput = typeof inputPath === 'string' ? resolvePath(inputPath) : inputPath
    const image = await readImage(imageInput)
    ensureSupportedSize(image)

    const regions = positions ? parsePositions(positions, image) : [processingRegion(image.width, image.height)]
    const whole = regions.length === 1 && regions[0].left === 0 && regions[0].top === 0 && regions[0].width === image.width && regions[0].height === image.height

    const startedAt = Date.now()
    const original = Buffer.from(image.data) // PSNR 对照用（image.data 会被就地修改）
    const {ort, session} = await loadSession({file: modelFile, fallback: DEFAULT_MODEL, label: '编码器', threads, modelMode})
    for (const region of regions) {
        await embedRegion(ort, session, image, region, bits, strength)
    }
    const quality = psnr(image.data, original, image.width, image.height)

    const output = resolvePath(outputPath)
    const data = image.hasAlpha ? image.data : stripAlpha(image.data, image.width, image.height)
    const format = await saveImage(output, {width: image.width, height: image.height, data, channels: image.hasAlpha ? 4 : 3}, outputFormat)
    return {
        input: typeof inputPath === 'string' ? imageInput : '(内存像素)',
        output,
        format,
        quality,
        elapsed: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
        width: image.width,
        height: image.height,
        mode: mode ?? 'utf8',
        strength,
        regions,
        whole
    }
}

// 检测（内部实现）：用检测器定位水印区域并逐个解码，返回所有命中（无需预先知道水印的位置/大小）。
// 检测器输入：整图缩放到最长边 ≤1600 → [-1,1]；输出 boxes（检测输入坐标）+ scores。
// inputPath 可以是路径字符串，也可以是内存像素 {data, width, height, channels?}。
// 返回 {hits: [{left, top, width, height, score, content, whole?}], candidates, elapsed, ...}；未命中时 hits 为空数组。
const checkWatermark = async ({inputPath, detectorFile, decoderFile, threads, modelMode, detectThreshold}) => {
    if (!inputPath) throw new Error('check 需要输入图片：input（路径或 {data,width,height,channels?} 内存像素）')

    const threshold = detectThreshold === undefined || detectThreshold === null || detectThreshold === ''
        ? DEFAULT_DETECT_THRESHOLD
        : Number(detectThreshold)
    if (!Number.isFinite(threshold)) throw new Error(`detectThreshold 必须是数字，当前为：${detectThreshold}`)

    const imageInput = typeof inputPath === 'string' ? resolvePath(inputPath) : inputPath
    const image = await readImage(imageInput)
    const scale = Math.min(1, DETECT_MAX_EDGE / Math.max(image.width, image.height))
    const detectWidth = Math.max(1, Math.round(image.width * scale))
    const detectHeight = Math.max(1, Math.round(image.height * scale))

    const startedAt = Date.now()
    // 检测器是 Faster R-CNN（含 NMS/RoI），DirectML 下结果错误且会导致 Bun 崩溃，固定用 CPU
    const {ort, session: detector} = await loadSession({file: detectorFile, fallback: DEFAULT_DETECTOR, label: '检测器', threads, modelMode: ['cpu']})
    const rgb = await resizeImageRGB(imageInput, detectWidth, detectHeight)
    const detection = await detector.run({
        [detector.inputNames[0]]: new ort.Tensor('float32', toNCHW(rgb, detectWidth, detectHeight), [1, 3, detectHeight, detectWidth])
    })
    const boxesName = detector.outputNames.find((name) => /box/i.test(name)) ?? detector.outputNames[0]
    const scoresName = detector.outputNames.find((name) => /score/i.test(name)) ?? detector.outputNames[1]
    const boxes = detection[boxesName].data
    const scores = detection[scoresName].data

    // 框映射回原图坐标 → 阈值过滤 → 按置信度降序
    const regions = []
    for (let i = 0; i < scores.length; i++) {
        if (scores[i] < threshold) continue
        const x1 = clamp(Math.round(boxes[i * 4] / scale), 0, image.width - 1)
        const y1 = clamp(Math.round(boxes[i * 4 + 1] / scale), 0, image.height - 1)
        const x2 = clamp(Math.round(boxes[i * 4 + 2] / scale), x1 + 1, image.width)
        const y2 = clamp(Math.round(boxes[i * 4 + 3] / scale), y1 + 1, image.height)
        regions.push({left: x1, top: y1, width: x2 - x1, height: y2 - y1, score: scores[i]})
    }
    regions.sort((a, b) => b.score - a.score)

    // 逐个候选区域裁剪 → 严格解码（限制纠错位数，避免对"半水印"裁剪误判）
    const {session: decoder} = await loadSession({file: decoderFile, fallback: DEFAULT_DECODER, label: '解码器', threads, modelMode})
    const decodeRegion = async (region) => {
        const small = await resizeToRGB(imageInput, DECODE_RESOLUTION, region)
        return decodePayload(await runDecoder(ort, decoder, small), true)
    }
    const hits = []
    for (const region of regions) {
        let decoded = await decodeRegion(region)
        let found = region
        if (decoded === null) {
            // 精修：检测框可能不精确（位置/长宽比），以框中心为基准尝试多种长宽比与尺寸
            const cx = region.left + region.width / 2
            const cy = region.top + region.height / 2
            const long = Math.max(region.width, region.height)
            const candidates = []
            for (const ratio of [1, 1.5, 2]) {
                for (const scale of [1.0, 0.8, 1.2]) {
                    const length = Math.round(long * scale)
                    candidates.push([length, Math.round(length / ratio)])
                    candidates.push([Math.round(length / ratio), length])
                }
            }
            for (const [width, height] of candidates) {
                if (width < 1 || height < 1 || width > image.width || height > image.height) continue
                const refined = {
                    left: clamp(Math.round(cx - width / 2), 0, image.width - width),
                    top: clamp(Math.round(cy - height / 2), 0, image.height - height),
                    width,
                    height
                }
                decoded = await decodeRegion(refined)
                if (decoded !== null) {
                    found = refined
                    break
                }
            }
        }
        if (decoded !== null) hits.push({...found, score: region.score, content: decoded.content, mode: decoded.mode})
    }

    // 兜底：候选都没解出时，尝试整图区域（覆盖"整图水印"）
    if (hits.length === 0) {
        const whole = processingRegion(image.width, image.height)
        const small = await resizeToRGB(imageInput, DECODE_RESOLUTION, whole)
        const decoded = decodePayload(await runDecoder(ort, decoder, small))
        if (decoded !== null) hits.push({left: whole.left, top: whole.top, width: whole.width, height: whole.height, whole: true, content: decoded.content, mode: decoded.mode})
    }

    const elapsed = Number(((Date.now() - startedAt) / 1000).toFixed(1))
    return {
        input: typeof inputPath === 'string' ? imageInput : '(内存像素)',
        hits,
        candidates: regions.length,
        elapsed,
        width: image.width,
        height: image.height,
        detectWidth,
        detectHeight,
        threshold
    }
}

// ---- OOP API：new Watermark(options) → .add() / .check() ----
// options（全部可选；单次调用可覆盖其中与调用相关的项）：
//   modelFile / decoderFile / detectorFile  模型路径（相对路径相对"程序所在目录"解析）
//   wmStrength      水印强度，默认 0.8（单次 add 可用 strength 覆盖）
//   threads         推理线程数："full" 或正整数
//   modelMode       运行模式数组，按序优先，默认 ["dml","cpu"]（检测器固定 CPU）
//   detectThreshold 检测置信度阈值，默认 0.5（单次 check 可覆盖）
// input 支持：图片路径字符串，或内存原始像素 {data, width, height, channels?}。
export class Watermark {
    constructor(options = {}) {
        this.options = {...options}
    }

    // 嵌入水印：watermarkPosition 省略时整图嵌入（长宽比 >2 取中心正方形）。
    // 返回 {input, output, format, quality, elapsed, width, height, mode, strength, regions, whole}
    async add({input, watermarkContent, mode, watermarkPosition, outputPath, outputFormat, strength} = {}) {
        return await addWatermark({
            inputPath: input,
            outputPath,
            watermarkContent,
            outputFormat,
            positions: watermarkPosition,
            mode,
            wmStrength: strength ?? this.options.wmStrength,
            modelFile: this.options.modelFile,
            threads: this.options.threads,
            modelMode: this.options.modelMode
        })
    }

    // 检测水印：盲定位（无需预先知道位置/大小）。
    // 返回 {input, hits: [{left, top, width, height, score, content, mode, whole?}], candidates, elapsed, width, height, ...}
    async check({input, detectThreshold} = {}) {
        return await checkWatermark({
            inputPath: input,
            detectThreshold: detectThreshold ?? this.options.detectThreshold,
            detectorFile: this.options.detectorFile,
            decoderFile: this.options.decoderFile,
            threads: this.options.threads,
            modelMode: this.options.modelMode
        })
    }
}
