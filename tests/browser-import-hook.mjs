/*
ESM resolve hook：把前端模块的根绝对路径 import（'/js/...'）映射到
仓库 public/ 目录——浏览器里由静态服务器解析，Node 侧测试经此 hook
等价解析。经 helpers.importBrowserModule 触发注册（幂等，进程内一次）；
只拦截 '/js/' 开头的说明符，其余走默认解析——现有无绝对 import 的
被测模块行为不变。
*/

const PUBLIC_ROOT = new URL('../public/', import.meta.url); // tests/ → 仓库根 → public/

export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('/js/')) {
        // '/js/core/utils.js' → '<repo>/public/js/core/utils.js'
        return nextResolve(new URL(`.${specifier}`, PUBLIC_ROOT).href, context);
    }
    return nextResolve(specifier, context);
}
