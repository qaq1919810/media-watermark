// 运行环境预打包脚本：把原生依赖（onnxruntime-node、sharp）整理成"外置运行库"，
// 生成到分发包的 runtime/<库名>/ 下（默认 dist/<应用名>/runtime/，可用 --out 指定）。
//
// 目录形状说明（每个库的内部形状由"库自身的相对加载路径"决定，不能随意拍平）：
//   runtime/onnxruntime-node/
//     js/ort.cjs                                   ← 预打包的 JS 单文件
//     bin/napi-v6/<平台>/<架构>/{binding, 运行库, DirectML 等 DLL}   ← 库内部写死了 ../bin/napi-v6/... 的相对引用
//   runtime/sharp/
//     index.js + *.node + libvips 动态库            ← 打包器产物 + binding 必须与依赖库同目录
//
// 为什么需要外置：bun build --compile 无法正确处理这些原生模块（内嵌后加载不到配套 DLL），
// 且 standalone 运行时不解析 node_modules 裸包名，所以必须"预打包成自包含 JS + 外置原生资源"，
// 由程序运行时按真实路径加载（见 src/utils/image.mjs、src/watermark.mjs）。
//
// 用法：bun scripts/setup-runtime.mjs [--platform=win32] [--arch=x64] [--out=dist/media-watermark]
import {copyFile, mkdir, readdir, rename, rm} from 'node:fs/promises'
import {join} from 'node:path'

const PROJECT_ROOT = process.cwd()

// 各平台需要复制的主运行库文件名（binding 各平台同名）。
const nativeFileNames = (platform) => {
    // win32 额外带上 DirectML 及其编译器 DLL（DML 执行提供器需要；缺失会退化为 CPU）
    if (platform === 'win32') return ['onnxruntime_binding.node', 'onnxruntime.dll', 'DirectML.dll', 'dxcompiler.dll', 'dxil.dll']
    if (platform === 'linux') return ['onnxruntime_binding.node', 'libonnxruntime.so.1']
    if (platform === 'darwin') return ['onnxruntime_binding.node', 'libonnxruntime.1.dylib']
    throw new Error(`暂不支持的平台：${platform}`)
}

export const setupRuntime = async (platform = process.platform, arch = process.arch, outRoot) => {
    if (!outRoot) {
        const pkg = await Bun.file(join(PROJECT_ROOT, 'package.json')).json()
        outRoot = join(PROJECT_ROOT, 'dist', pkg.name)
    }
    const runtimeDir = join(outRoot, 'runtime')

    // 每次重新生成，避免残留旧版本文件。
    await rm(runtimeDir, {recursive: true, force: true})

    // ---- onnxruntime-node ----
    const packageDir = join(PROJECT_ROOT, 'node_modules', 'onnxruntime-node')
    const ortJsDir = join(runtimeDir, 'onnxruntime-node', 'js')
    await mkdir(ortJsDir, {recursive: true})

    console.log('打包 onnxruntime-node 的 JS 为单文件……')
    const build = await Bun.build({
        entrypoints: [join(packageDir, 'dist', 'index.js')],
        target: 'bun',
        format: 'cjs',
        outdir: ortJsDir
    })
    if (!build.success) {
        throw new Error(`JS 打包失败：\n${build.logs.join('\n')}`)
    }
    // 输出必须用 .cjs 扩展名：项目 package.json 是 "type": "module"，
    // 否则该文件会被当作 ESM 解析（这是之前验证过的关键细节）。
    const entry = build.outputs.find((output) => output.kind === 'entry-point') ?? build.outputs[0]
    await rename(entry.path, join(ortJsDir, 'ort.cjs'))

    console.log(`复制 onnxruntime 原生文件（${platform}/${arch}）……`)
    const ortNativeDir = join(runtimeDir, 'onnxruntime-node', 'bin', 'napi-v6', platform, arch)
    await mkdir(ortNativeDir, {recursive: true})
    for (const name of nativeFileNames(platform)) {
        await copyFile(join(packageDir, 'bin', 'napi-v6', platform, arch, name), join(ortNativeDir, name))
    }

    // ---- sharp ----
    console.log('打包 sharp 的 JS 并复制原生库……')
    const sharpOutDir = join(runtimeDir, 'sharp')
    await mkdir(sharpOutDir, {recursive: true})
    const sharpBuild = await Bun.build({
        entrypoints: [join(PROJECT_ROOT, 'node_modules', 'sharp', 'dist', 'index.cjs')],
        target: 'bun',
        format: 'cjs',
        outdir: sharpOutDir
    })
    if (!sharpBuild.success) {
        throw new Error(`sharp JS 打包失败：\n${sharpBuild.logs.join('\n')}`)
    }
    // 打包器会把原生 binding（*.node）作为资源复制到输出目录并改写成相对引用；
    // 这里补齐 libvips 动态库（binding 会在同目录查找它们）——.node 已由打包器输出，跳过。
    const sharpNativeDir = join(PROJECT_ROOT, 'node_modules', '@img', `sharp-${platform}-${arch}`, 'lib')
    let sharpNativeFiles
    try {
        sharpNativeFiles = await readdir(sharpNativeDir)
    } catch {
        throw new Error(`缺少 sharp 原生包：${sharpNativeDir}（跨平台构建需先安装对应平台的 optional 依赖）`)
    }
    for (const file of sharpNativeFiles) {
        if (file.endsWith('.node')) continue
        await copyFile(join(sharpNativeDir, file), join(sharpOutDir, file))
    }

    console.log(`runtime 已生成：${runtimeDir}`)
}

// 直接运行时（bun scripts/setup-runtime.mjs）解析可选参数。
if (import.meta.main) {
    const option = (name) => process.argv.find((arg) => arg.startsWith(`${name}=`))?.split('=')[1]
    await setupRuntime(option('--platform') ?? process.platform, option('--arch') ?? process.arch, option('--out'))
}
