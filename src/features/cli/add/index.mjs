// CLI 子命令 add：把水印内容嵌入图片，并打印输入/输出/耗时/PSNR。
import {Watermark} from '#watermark'

export const runAdd = async (options) => {
    const watermark = new Watermark(options)
    const result = await watermark.add({
        input: options.inputPath,
        watermarkContent: options.watermarkContent,
        mode: options.mode,
        watermarkPosition: options.positions,
        outputPath: options.outputPath,
        outputFormat: options.outputFormat
    })

    const scope = result.regions.length > 1
        ? `${result.regions.length} 个区域`
        : result.whole
            ? '整图'
            : `处理区域 ${result.regions[0].width}×${result.regions[0].height}`
    console.log(`输入：${result.input}（${result.width}×${result.height}），强度 ${result.strength}，模式 ${result.mode}，${scope}`)
    console.log(`输出：${result.output}（${result.format.toUpperCase()}）`)
    console.log(`完成，用时 ${result.elapsed} 秒，PSNR ${result.quality.toFixed(2)} dB`)
    return result
}
