// 命令行解析（CLI 工具）：子命令 add（嵌入）/ check（检测）/ web（服务）+ 选项。
// 选项支持三种写法："-i 值"、"--inputPath 值"、"--inputPath=值"。
// 这里只负责"解析"；参数是否齐全由各子命令自己校验（因为配置文件可以补齐缺省值）。
export const usage = `media-watermark —— 图片隐形水印工具（基于 Adobe TrustMark）

用法：
  media-watermark add   -i <输入图> -o <输出图> -w <水印内容> [选项]
  media-watermark check -i <输入图> [选项]
  media-watermark web   [选项]
  media-watermark       （不带子命令时默认启动 web，方便双击直接进浏览器）

子命令：
  add    把水印内容嵌入图片（整图；图片最短边不小于 150 像素）
  check  用检测器盲定位水印区域并解码，输出水印位置
  web    启动 Web 服务（静态托管 + /api/add + /api/check）

选项：
  -c, --config <路径>            配置文件（相对/绝对）；省略时尝试程序旁的 config.jsonc
  -m, --modelFile <路径>         编码器模型路径，默认 model/encoder_Q.onnx
      --decoderFile <路径>       解码器模型路径（check 使用），默认 model/decoder_Q.onnx
      --detectorFile <路径>      检测器模型路径（check 使用），默认 model/detector_Q.onnx
      --detectThreshold <数字>   check 的置信度阈值，默认 0.5（低于此值的候选框丢弃）
      --webPort <端口>           web 服务端口，默认 6969
      --noOpen                   web 启动时不自动打开浏览器
      --modelMode <列表>         运行模式，逗号分隔、按序优先（如 dml,cpu）；不可用的自动跳过下退
  -s, --wmStrength <数字>        水印强度，默认 0.8；官方推荐范围 0.7~1.5
  -t, --threads <full|数字>      推理线程数；full=用满，数字超出本机逻辑核心数直接报错
  -o, --outputPath <路径>        add 的输出图片路径（扩展名用于推断输出格式）
  -of, --outputFormat <格式名>    add 的输出格式（如 png/jpeg/webp，以本机实际支持为准）；
                                 省略时按输出路径扩展名决定（jpg 是 jpeg 别名）
  -i, --inputPath <路径>         输入图片路径
  -w, --watermarkContent <内容>  add 的水印内容
      --mode <ascii|utf8|bits>   add 的内容模式（默认 utf8）：
                                 ascii=每字符 7 位（最多 9 字符）；utf8=每字节 8 位（最多 8 字节）；bits=原始位（最多 63 位）
  -h, --help                     显示本帮助

说明：以上参数也可以写进配置文件（JSONC），与 -c 搭配使用；优先级 CLI 参数 > 配置文件。
输入图片格式由 sharp 自动识别（png/jpeg/webp/tiff/gif/svg/heif 等，受运行环境支持情况影响）。
add 对长宽比 >2 的图片只处理中心正方形区域；check 用检测器自动定位（每次最多 4 个区域）。`

const FLAGS = new Map([
    ['-c', 'configFile'],
    ['--config', 'configFile'],
    ['-m', 'modelFile'],
    ['--modelFile', 'modelFile'],
    ['--decoderFile', 'decoderFile'],
    ['--detectorFile', 'detectorFile'],
    ['--detectThreshold', 'detectThreshold'],
    ['--webPort', 'webPort'],
    ['--noOpen', 'noOpen'],
    ['--modelMode', 'modelMode'],
    ['-s', 'wmStrength'],
    ['--wmStrength', 'wmStrength'],
    ['-t', 'threads'],
    ['--threads', 'threads'],
    ['-o', 'outputPath'],
    ['--outputPath', 'outputPath'],
    ['-of', 'outputFormat'],
    ['--outputFormat', 'outputFormat'],
    ['-i', 'inputPath'],
    ['--inputPath', 'inputPath'],
    ['-w', 'watermarkContent'],
    ['--watermarkContent', 'watermarkContent'],
    ['--mode', 'mode'],
    ['-h', 'help'],
    ['--help', 'help']
])

export const parseArgs = (argv) => {
    const result = {command: '', help: false, noOpen: false, configFile: undefined, values: {}}
    const tokens = [...argv]
    while (tokens.length > 0) {
        const token = tokens.shift()
        if (!token.startsWith('-')) {
            if (result.command) throw new Error(`多余的参数：${token}`)
            result.command = token
            continue
        }
        const equalIndex = token.indexOf('=')
        const name = equalIndex === -1 ? token : token.slice(0, equalIndex)
        const key = FLAGS.get(name)
        if (!key) throw new Error(`未知选项：${name}`)
        if (key === 'help') {
            result.help = true
            continue
        }
        if (key === 'noOpen') {
            result.noOpen = true
            continue
        }
        let value = equalIndex === -1 ? undefined : token.slice(equalIndex + 1)
        if (value === undefined) {
            value = tokens.shift()
            if (value === undefined) throw new Error(`选项缺少值：${name}`)
        }
        if (key === 'configFile') result.configFile = value
        else result.values[key] = value
    }
    if (result.command && !['add', 'check', 'web'].includes(result.command)) {
        throw new Error(`未知子命令：${result.command}（可用：add / check / web）`)
    }
    return result
}
