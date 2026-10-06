// Web 路由：POST /api/add —— 按 watermarkPosition 给出的区域逐个嵌入水印。
// body: {filepath, watermarkPosition: [[{x,y},{x,y}], ...], watermarkContent, mode, outputFile}
import {Hono} from 'hono'

// 依赖注入：传入 Watermark 实例（服务启动时创建一次，模型会话在实例间共享缓存）。
const createAddRoute = (watermark) => {
    const addApp = new Hono()

    addApp.post('/', async (c) => {
        try {
            const body = await c.req.json()
            const result = await watermark.add({
                input: body.filepath,
                outputPath: body.outputFile,
                watermarkContent: body.watermarkContent,
                mode: body.mode,
                watermarkPosition: body.watermarkPosition
            })
            return c.json({ok: true, outputFile: result.output, psnr: Number(result.quality.toFixed(2))})
        } catch (error) {
            return c.json({ok: false, error: error?.message ?? String(error)}, 400)
        }
    })

    return addApp
}

export default createAddRoute
