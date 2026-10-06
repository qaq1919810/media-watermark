// 构建脚本：生成 dist/<应用名>/ 分发包（exe + runtime/<库名>/ + model/）。
// 用法：bun scripts/build.mjs [--platform=linux] [--arch=x64]（默认当前平台）
import {createReadStream, createWriteStream} from 'node:fs'
import {access, cp, mkdir, readdir, stat} from 'node:fs/promises'
import {join} from 'node:path'
import {pipeline} from 'node:stream/promises'
import tar from 'tar-stream'
import {setupRuntime} from './setup-runtime.mjs'

const PROJECT_ROOT = process.cwd()
const option = (name) => process.argv.find((arg) => arg.startsWith(`${name}=`))?.split('=')[1]
const platform = option('--platform') ?? process.platform
const arch = option('--arch') ?? process.arch
const isCurrent = platform === process.platform && arch === process.arch

// 分发包统一收进 dist/<应用名>/：exe + runtime/<库名>/... + model/
const pkg = await Bun.file(join(PROJECT_ROOT, 'package.json')).json()
const appDir = join(PROJECT_ROOT, 'dist', pkg.name)
const outfile = join(appDir, platform === 'win32' ? `${pkg.name}.exe` : pkg.name)
const target = isCurrent ? 'bun' : `bun-${platform === 'win32' ? 'windows' : platform}-${arch}`
const CONFIG_NAMES = ['config.jsonc', 'config.json']

const exists = async (path) => {
    try {
        await access(path)
        return true
    } catch {
        return false
    }
}

await mkdir(appDir, {recursive: true})
await setupRuntime(platform, arch, appDir)

console.log(`编译可执行文件（target=${target}）……`)
const compile = Bun.spawnSync(
    [process.execPath, 'build', 'src/index.mjs', '--compile', '--target', target, '--outfile', outfile],
    {cwd: PROJECT_ROOT, stdio: ['inherit', 'inherit', 'inherit']}
)
if (compile.exitCode !== 0) throw new Error(`编译失败（退出码 ${compile.exitCode}）`)

// 模型按 exe 的同级目录分发；已存在则跳过（模型很大，避免每次构建都复制一遍）。
const modelDir = join(appDir, 'model')
if (await exists(modelDir)) {
    console.log('model 已存在，跳过复制')
} else {
    console.log('复制模型到分发包 model/……')
    await cp(join(PROJECT_ROOT, 'model'), modelDir, {recursive: true})
}

// 配置文件（用户自己维护，软件不生成）：把项目根当前使用的配置文件原样复制到分发包。
const configName = (
    await Promise.all(CONFIG_NAMES.map(async (name) => ((await exists(join(PROJECT_ROOT, name))) ? name : null)))
).find(Boolean)
if (configName) {
    console.log(`复制配置文件 ${configName} 到分发包……`)
    await cp(join(PROJECT_ROOT, configName), join(appDir, configName))
} else {
    console.log('未找到配置文件（可选），跳过')
}

// 静态资源（Web 服务的前端页面）复制到分发包。
const publicDir = join(PROJECT_ROOT, 'webui')
if (await exists(publicDir)) {
    console.log('复制 webui/ 到分发包……')
    await cp(publicDir, join(appDir, 'webui'), {recursive: true})
}

// README 放到分发包根目录。
const readmeName = (
    await Promise.all(['README.md', 'readme.md'].map(async (name) => ((await exists(join(PROJECT_ROOT, name))) ? name : null)))
).find(Boolean)
if (readmeName) {
    console.log(`复制 ${readmeName} 到分发包……`)
    await cp(join(PROJECT_ROOT, readmeName), join(appDir, readmeName))
}

// LICENSE 放到分发包根目录。
const licenseName = (
    await Promise.all(['LICENSE', 'LICENSE.md', 'LICENSE.txt'].map(async (name) => ((await exists(join(PROJECT_ROOT, name))) ? name : null)))
).find(Boolean)
if (licenseName) {
    console.log(`复制 ${licenseName} 到分发包……`)
    await cp(join(PROJECT_ROOT, licenseName), join(appDir, licenseName))
}

console.log(`构建完成：${outfile}`)

// 打包为 tar（tar-stream，纯 JS 流式打包）：把整个分发包目录打成 <应用名>-<平台>-<架构>.tar
const tarPath = join(PROJECT_ROOT, 'dist', `${pkg.name}-${platform}-${arch}.tar`)
console.log(`打包为 tar：${tarPath}`)
const pack = tar.pack()
const tarStream = createWriteStream(tarPath)
const piping = pipeline(pack, tarStream)
// 递归把目录写入 tar；目录条目以 / 结尾，文件按流写入（带 size/mode/mtime）
const addDirectory = async (dir, name) => {
    const entries = await readdir(dir, {withFileTypes: true})
    for (const entry of entries) {
        const full = join(dir, entry.name)
        const entryName = `${name}/${entry.name}`
        if (entry.isDirectory()) {
            pack.entry({name: `${entryName}/`, type: 'directory'})
            await addDirectory(full, entryName)
        } else {
            const info = await stat(full)
            const mode = entry.name.endsWith('.exe') ? 0o755 : 0o644
            await new Promise((resolve, reject) => {
                const writable = pack.entry({name: entryName, size: info.size, mode, mtime: info.mtime}, (error) => (error ? reject(error) : resolve()))
                createReadStream(full).pipe(writable)
            })
        }
    }
}
await addDirectory(appDir, pkg.name)
pack.finalize()
await piping
console.log(`tar 已生成：${tarPath}`)
