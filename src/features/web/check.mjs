// Web 路由：POST /api/check —— 盲定位水印区域并解码。
// body: {outputFile} → [{position: [{x,y},{x,y}], content, mode}]（未命中返回空数组）
import {Hono} from 'hono'

// 依赖注入：传入 Watermark 实例（服务启动时创建一次，模型会话在实例间共享缓存）。
const createCheckRoute = (watermark) => {
    const checkApp = new Hono()

    checkApp.post('/', async (c) => {
        try {
            const body = await c.req.json()
            const {hits} = await watermark.check({input: body.outputFile})
            return c.json(hits.map((hit) => ({
                position: [{x: hit.left, y: hit.top}, {x: hit.left + hit.width, y: hit.top + hit.height}],
                content: hit.content,
                mode: hit.mode
            })))
        } catch (error) {
            return c.json({ok: false, error: error?.message ?? String(error)}, 400)
        }
    })

    return checkApp
}

export default createCheckRoute
