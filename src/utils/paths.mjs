import {dirname, isAbsolute, join, resolve} from 'node:path'

// 开发模式返回项目根目录（cwd），编译模式返回可执行文件所在目录。
// 需要 Bun >= 1.4（Bun.isStandaloneExecutable 是 1.4 新增 API）。
export const applicationDirectory = Bun.isStandaloneExecutable ? dirname(process.execPath) : process.cwd()

// 所有需要放在程序同级的文件（模型、runtime、配置）都通过这个工具生成路径。
export const applicationFile = (...segments) => join(applicationDirectory, ...segments)

// 用户传入的路径：绝对路径原样使用；相对路径一律相对"程序所在目录"解析。
export const resolvePath = (path) => (isAbsolute(path) ? path : resolve(applicationDirectory, path))
