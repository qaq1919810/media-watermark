// Web 功能入口：组装 Hono 应用（静态托管 webui/ + /api 子路由）并启动服务。
//   GET  /api/image?path=<服务端路径>  读取图片（供前端展示）
//   POST /api/add    {filepath, watermarkPosition, watermarkContent, mode, outputFile} → {ok, outputFile, psnr}
//   POST /api/check  {outputFile} → [{position, content, mode}]（未命中返回空数组）
import {Hono} from 'hono'
import {serveStatic} from 'hono/bun'
import {join} from 'node:path'
import {applicationDirectory} from '#utils/paths.mjs'
import {Watermark} from '#watermark'
import imageApp from './image.mjs'
import createAddRoute from './add.mjs'
import createCheckRoute from './check.mjs'

const DEFAULT_WEB_PORT = 6969

// 用系统默认浏览器打开 URL（打不开就算了，URL 已打印）。
const openBrowser = (url) => {
    try {
        const command = process.platform === 'win32'
            ? ['cmd', '/c', 'start', '', url]
            : process.platform === 'darwin'
                ? ['open', url]
                : ['xdg-open', url]
        Bun.spawn(command, {stdio: ['ignore', 'ignore', 'ignore']})
    } catch {
        // ignore
    }
}

export const startWeb = async (options) => {
    const port = options.webPort === undefined || options.webPort === null || options.webPort === ''
        ? DEFAULT_WEB_PORT
        : Number(options.webPort)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`webPort 必须是 1~65535 的整数，当前为：${options.webPort}`)
    }

    // 水印实例：服务启动时创建一次，所有请求复用（模型会话带缓存）。
    const watermark = new Watermark(options)

    const api = new Hono()
    api.route('/image', imageApp)
    api.route('/add', createAddRoute(watermark))
    api.route('/check', createCheckRoute(watermark))

    const app = new Hono()
    app.use('/*', serveStatic({root: join(applicationDirectory, 'webui')}))
    app.route('/api', api)

    const server = Bun.serve({port, fetch: app.fetch})
    const addUrl = `http://localhost:${port}/add.html`
    console.log(`web 服务已启动（Ctrl+C 停止）：`)
    console.log(`  添加水印：${addUrl}`)
    console.log(`  检测水印：http://localhost:${port}/check.html`)
    if (!options.noOpen) {
        console.log('  正在打开浏览器…')
        openBrowser(addUrl)
    }
    return server
}
