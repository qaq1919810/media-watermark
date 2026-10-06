// 入口：解析命令行 → 合并配置文件（CLI 优先级高于配置文件）→ 分发 add / check / web 子命令。
import {parseArgs, usage} from '#cli'
import {loadConfig} from '#config'
import {runAdd} from '#cli/add'
import {runCheck} from '#cli/check'
import {startWeb} from '#web'

try {
    const cli = parseArgs(process.argv.slice(2))
    if (cli.help) {
        console.log(usage)
        process.exit(0)
    }
    // 未指定子命令时默认启动 web（方便双击 exe 直接进浏览器）
    const command = cli.command || 'web'

    // 配置文件：-c 指定时必须存在；未指定时尝试程序旁的 config.jsonc，没有则视为空配置。
    const fileConfig = (await loadConfig(cli.configFile)) ?? {}
    const options = {
        modelFile: cli.values.modelFile ?? fileConfig.modelFile,
        decoderFile: cli.values.decoderFile ?? fileConfig.decoderFile,
        detectorFile: cli.values.detectorFile ?? fileConfig.detectorFile,
        detectThreshold: cli.values.detectThreshold ?? fileConfig.detectThreshold,
        webPort: cli.values.webPort ?? fileConfig.webPort,
        // modelMode：CLI 传"逗号分隔字符串"，配置文件里是数组；两种都交给运行层按序优先处理
        modelMode: cli.values.modelMode
            ? cli.values.modelMode.split(',').map((name) => name.trim()).filter(Boolean)
            : fileConfig.modelMode,
        wmStrength: cli.values.wmStrength ?? fileConfig.wmStrength,
        threads: cli.values.threads ?? fileConfig.threads ?? 'full',
        inputPath: cli.values.inputPath ?? fileConfig.inputPath,
        outputPath: cli.values.outputPath ?? fileConfig.outputPath,
        outputFormat: cli.values.outputFormat ?? fileConfig.outputFormat,
        watermarkContent: cli.values.watermarkContent ?? fileConfig.watermarkContent,
        mode: cli.values.mode ?? fileConfig.mode,
        noOpen: cli.noOpen || Boolean(fileConfig.noOpen)
    }

    if (command === 'add') {
        await runAdd(options)
    } else if (command === 'check') {
        await runCheck(options)
    } else {
        await startWeb(options)
    }
} catch (error) {
    console.error(`错误：${error?.message ?? error}`)
    process.exit(1)
}
