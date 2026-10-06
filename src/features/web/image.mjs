// Web 路由：GET /api/image?path=<服务端路径> —— 读取图片供前端展示。
import {Hono} from 'hono'
import {resolvePath} from '#utils/paths.mjs'

const imageApp = new Hono()

imageApp.get('/', async (c) => {
    const filepath = c.req.query('path')
    if (!filepath) return c.json({ok: false, error: '缺少 path 参数'}, 400)
    const path = resolvePath(filepath)
    const file = Bun.file(path)
    if (!(await file.exists())) return c.json({ok: false, error: `文件不存在：${path}`}, 404)
    return new Response(file)
})

export default imageApp
