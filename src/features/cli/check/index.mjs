// CLI 子命令 check：检测图片中的水印，打印位置/内容/模式，并输出机器可读的 JSON。
import {Watermark} from '#watermark'

export const runCheck = async (options) => {
    const watermark = new Watermark(options)
    const result = await watermark.check({input: options.inputPath})

    console.log(`输入：${result.input}（${result.width}×${result.height}），检测输入 ${result.detectWidth}×${result.detectHeight}，阈值 ${result.threshold}`)
    if (result.hits.length === 0) {
        throw new Error(`未检测到水印（用时 ${result.elapsed}s）`)
    }

    console.log(`检测到 ${result.hits.length} 处水印（用时 ${result.elapsed}s）：`)
    for (const hit of result.hits) {
        const where = hit.whole
            ? `整图 ${hit.width}×${hit.height}`
            : `(${hit.left},${hit.top})-(${hit.left + hit.width},${hit.top + hit.height}) 置信度 ${hit.score.toFixed(3)}`
        console.log(`  ${where} → [${hit.mode}] ${hit.content}`)
    }
    console.log(JSON.stringify(result.hits.map((hit) => ({
        position: [{x: hit.left, y: hit.top}, {x: hit.left + hit.width, y: hit.top + hit.height}],
        content: hit.content,
        mode: hit.mode
    }))))
    return result
}
