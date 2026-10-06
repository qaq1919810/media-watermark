// 图像编解码工具：基于 sharp（libvips 原生模块）。
// - 开发模式（bun 直接运行）：从 node_modules/sharp 加载；
// - 编译模式（独立 exe）：从 exe 同级的 runtime/sharp 加载（预打包 JS 单文件 + 原生资源，
//   见 scripts/setup-runtime.mjs）。
// 两条路径都用"运行时计算 + 动态 import"，不写裸包名，避免打包器把原生模块打进 exe。
import {extname} from 'node:path'
import {pathToFileURL} from 'node:url'
import {applicationFile} from './paths.mjs'

// JPEG 输出质量（仅输出 jpeg 且未特别指定时使用；不建议低于 85，以免影响水印存活）。
const JPEG_QUALITY = 90

// 加载 sharp（单例缓存）。
let sharpPromise
export const loadSharp = () => {
    if (!sharpPromise) {
        sharpPromise = (async () => {
            const entry = Bun.isStandaloneExecutable
                ? applicationFile('runtime', 'sharp', 'index.js')
                : applicationFile('node_modules', 'sharp', 'dist', 'index.cjs')
            if (!(await Bun.file(entry).exists())) {
                const hint = Bun.isStandaloneExecutable
                    ? '请确认 exe 旁有 runtime/sharp 目录（可用 bun run build 生成）'
                    : '请先执行 bun install'
                throw new Error(`找不到 sharp 运行文件：${entry}（${hint}）`)
            }
            const module = await import(pathToFileURL(entry).href)
            return module.default ?? module
        })()
    }
    return sharpPromise
}

// 本机环境实际支持"输出到文件"的格式列表（直接来自 sharp 运行时能力，不写死）。
export const listOutputFormats = async () => {
    const sharp = await loadSharp()
    return Object.entries(sharp.format)
        .filter(([, info]) => info.output.file)
        .map(([name]) => name)
}

// 规范化格式名：忽略大小写/空白；jpg 是 jpeg 的别名。
export const normalizeFormatName = (value) => {
    const name = String(value).trim().toLowerCase()
    return name === 'jpg' ? 'jpeg' : name
}

// 校验输出格式（动态查询 sharp 能力），返回规范化后的格式名。
export const assertOutputFormat = async (value) => {
    const name = normalizeFormatName(value)
    const sharp = await loadSharp()
    const capabilities = sharp.format[name]
    if (!capabilities || !capabilities.output.file) {
        throw new Error(`不支持的输出格式：${value}（本机可用：${(await listOutputFormats()).join(' / ')}）`)
    }
    return name
}

// 统一图像输入：路径字符串，或内存原始像素 {data, width, height, channels?}（默认 3 通道 RGB）。
// 返回 sharp 的 (source, options) 参数对，调用方写成 sharp(...toSharpSource(input)) 即可同时支持两种输入。
export const toSharpSource = (input) => {
    if (typeof input === 'string') return [input, undefined]
    const {data, width, height, channels = 3} = input ?? {}
    if (!data || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        throw new Error('图像输入必须是路径字符串，或 {data, width, height, channels?} 形式的内存像素')
    }
    return [Buffer.isBuffer(data) ? data : Buffer.from(data), {raw: {width, height, channels}}]
}

// 读取整图 RGBA 像素（自动应用 EXIF 方向、统一补齐 Alpha）。
// hasAlpha 表示原图本身是否带透明通道（输出编码时据此决定是否保留 Alpha）。
export const readImage = async (input) => {
    const sharp = await loadSharp()
    const [source, sourceOptions] = toSharpSource(input)
    const metadata = await sharp(source, sourceOptions).metadata()
    const {data, info} = await sharp(source, sourceOptions)
        .rotate()
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer({resolveWithObject: true})
    const hasAlpha = typeof input === 'string' ? Boolean(metadata.hasAlpha) : (input.channels ?? 3) === 4
    return {width: info.width, height: info.height, data, hasAlpha}
}

// 把图片（可选区域）缩放为 size×size 的 RGB 原始像素（拉伸填满，与官方预处理一致）。
// region 省略或等于整图时走单条 sharp 流水线；局部区域先按 EXIF 方向解码，再在像素层裁切、缩放。
export const resizeToRGB = async (input, size, region) => {
    const sharp = await loadSharp()
    const [source, sourceOptions] = toSharpSource(input)
    const metadata = await sharp(source, sourceOptions).metadata()
    // EXIF 方向 5~8 表示旋转 90°，rotate() 校正后宽高互换
    const swap = [5, 6, 7, 8].includes(metadata.orientation)
    const width = swap ? metadata.height : metadata.width
    const height = swap ? metadata.width : metadata.height
    const left = region?.left ?? 0
    const top = region?.top ?? 0
    const regionWidth = region?.width ?? width
    const regionHeight = region?.height ?? height

    if (left === 0 && top === 0 && regionWidth === width && regionHeight === height) {
        const {data} = await sharp(source, sourceOptions)
            .rotate()
            .resize(size, size, {fit: 'fill'})
            .toColourspace('srgb')
            .removeAlpha()
            .raw()
            .toBuffer({resolveWithObject: true})
        return data
    }

    // 局部区域：先解码为 3 通道整图，再逐行裁切，最后缩放
    const {data: rgb, info} = await sharp(source, sourceOptions)
        .rotate()
        .toColourspace('srgb')
        .removeAlpha()
        .raw()
        .toBuffer({resolveWithObject: true})
    const channels = info.channels
    const cropped = Buffer.alloc(regionWidth * regionHeight * channels)
    for (let y = 0; y < regionHeight; y++) {
        const start = ((top + y) * info.width + left) * channels
        rgb.copy(cropped, y * regionWidth * channels, start, start + regionWidth * channels)
    }
    const {data} = await sharp(cropped, {raw: {width: regionWidth, height: regionHeight, channels}})
        .resize(size, size, {fit: 'fill'})
        .raw()
        .toBuffer({resolveWithObject: true})
    return data
}

// 把整图缩放到指定宽高（返回 RGB 原始像素），用于检测器输入（最长边 ≤1600）。
export const resizeImageRGB = async (input, width, height) => {
    const sharp = await loadSharp()
    const {data} = await sharp(...toSharpSource(input))
        .rotate()
        .resize(width, height, {fit: 'fill'})
        .removeAlpha()
        .raw()
        .toBuffer({resolveWithObject: true})
    return data
}

// 把内存中的 RGB 原始像素缩放到指定宽高（供区域嵌入/解码复用，避免重复解码整图）。
export const resizeRawRGB = async (rgb, width, height, outWidth, outHeight) => {
    const sharp = await loadSharp()
    const {data} = await sharp(rgb, {raw: {width, height, channels: 3}})
        .resize(outWidth, outHeight, {fit: 'fill'})
        .raw()
        .toBuffer({resolveWithObject: true})
    return data
}

// 保存图片：格式 = 显式 outputFormat（经能力校验）或输出路径扩展名；返回实际使用的格式名。
// JPEG 不支持透明通道：带 Alpha 时自动去掉（保留 RGB 像素原值）。
export const saveImage = async (path, {width, height, data, channels = 3}, outputFormat) => {
    const sharp = await loadSharp()
    const extension = extname(path).slice(1)
    if (!outputFormat && !extension) {
        throw new Error(`无法从输出路径判断格式（无扩展名）：${path}，请用 -of/--outputFormat 指定`)
    }
    const format = await assertOutputFormat(outputFormat ?? extension)
    const actualChannels = format === 'jpeg' && channels === 4 ? 3 : channels
    const pixels = actualChannels === channels ? Buffer.from(data) : stripAlpha(data, width, height)
    const options = format === 'jpeg' ? {quality: JPEG_QUALITY} : {}
    await sharp(pixels, {raw: {width, height, channels: actualChannels}})
        .toFormat(format, options)
        .toFile(path)
    return format
}

// 去掉 Alpha 通道（RGBA → RGB，像素值原样保留）。
const stripAlpha = (rgba, width, height) => {
    const rgb = Buffer.alloc(width * height * 3)
    for (let i = 0; i < width * height; i++) {
        rgb[i * 3] = rgba[i * 4]
        rgb[i * 3 + 1] = rgba[i * 4 + 1]
        rgb[i * 3 + 2] = rgba[i * 4 + 2]
    }
    return rgb
}
