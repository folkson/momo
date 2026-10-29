import {defineConfig} from "vite";
import {svelte} from "@sveltejs/vite-plugin-svelte";
import { VitePWA } from 'vite-plugin-pwa'
import replace from '@rollup/plugin-replace'

const pwaOptions = {
    mode: 'development',
    base: '/',
    includeAssets: ['favicon.svg'],
    manifest: {
        name: 'momo',
        short_name: 'momo',
        theme_color: '#f3f4f6',
        // 图标保持相对路径（不要加前导斜杠）：构建后 neno.png 会被拷到
        // dist 根目录，与 manifest.webmanifest 同级，相对解析即 /neno.png。
        // 这样即便将来部署在子路径下（如 /momo/）也能正确解析。
        icons: [
            {
                src: 'neno.png',
                sizes: '512x512',
                type: 'image/png',
            },

        ],
    },
}

const replaceOptions = { preventAssignment: true, __DATE__: new Date().toISOString() }
const claims = process.env.CLAIMS === 'true'
const reload = process.env.RELOAD_SW === 'true'

if (process.env.SW === 'true') {
    pwaOptions.srcDir = 'src'
    pwaOptions.filename = claims ? 'claims-sw.ts' : 'prompt-sw.ts'
    pwaOptions.strategies = 'injectManifest'
    pwaOptions.manifest.name = 'PWA Inject Manifest'
    pwaOptions.manifest.short_name = 'PWA Inject'
}

if (claims)
    pwaOptions.registerType = 'autoUpdate'

if (reload) {
    // @ts-ignore
    replaceOptions.__RELOAD_SW__ = 'true'
}
// https://vitejs.dev/config/
export default defineConfig({
    plugins: [svelte(),
        VitePWA(pwaOptions),
        replace(replaceOptions),
    ]

});
