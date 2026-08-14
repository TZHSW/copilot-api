import { defineConfig } from "tsdown"

/**
 * 部署用构建：把依赖全部打进产物（noExternal），这样 dist-standalone/ 可以直接
 * 拷到目标机器跑，不需要 node_modules。
 *
 * 默认的 tsdown.config.ts 把依赖留在外面（开发用，构建快），产物单独拷走会
 * ERR_MODULE_NOT_FOUND。deploy/install.sh 和 deploy/pack.sh 用的是这一份。
 *
 * 产物 ~6 MB：main.js 加上 gpt-tokenizer 的几个数据 chunk，整个目录一起拷。
 */
export default defineConfig({
  entry: ["src/main.ts"],
  outDir: "dist-standalone",
  format: ["esm"],
  target: "es2022",
  platform: "node",
  noExternal: [/.*/],
  sourcemap: false,
  clean: true,
  removeNodeProtocol: false,

  env: {
    NODE_ENV: "production",
  },
})
