// 配置读取：本软件不生成配置文件（缺省时静默跳过，不写入任何文件）。
// - 显式指定 -c 时必须存在，否则报错；
// - 未指定时依次尝试程序旁的 config.jsonc / config.json，都不存在则返回 null（纯 CLI 参数模式）。
// 用 Bun.file 运行时读取而不是 import：打包器无法静态分析文件内容，配置永远不会被打进可执行文件。
import {applicationFile, resolvePath} from '#utils/paths.mjs'

// 默认配置文件候选（按顺序查找）。
const DEFAULT_CONFIG_NAMES = ['config.jsonc', 'config.json']

const parseConfig = async (path) => {
    try {
        return Bun.JSONC.parse(await Bun.file(path).text())
    } catch (error) {
        throw new Error(`配置文件解析失败（${path}）：${error.message}`)
    }
}

export const loadConfig = async (configFile) => {
    if (configFile) {
        const path = resolvePath(configFile)
        if (!(await Bun.file(path).exists())) throw new Error(`配置文件不存在：${path}`)
        return parseConfig(path)
    }
    for (const name of DEFAULT_CONFIG_NAMES) {
        const path = applicationFile(name)
        if (await Bun.file(path).exists()) return parseConfig(path)
    }
    return null
}
