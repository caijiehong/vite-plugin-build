import path from 'path';
import type { BuildOptions, InlineConfig, Plugin, UserConfig } from 'vite';
import { build, mergeConfig } from 'vite';
import type { ExternalOption, OutputOptions } from 'rollup';
import fg from 'fast-glob';
import runInTaskPool from 'run-in-task-pool';
import colors from 'picocolors';

let incrementCount = 0;
export function isVueTempFile(filePath: string) {
  // vue 文件转换的临时文件路径需要特殊处理
  if (filePath.includes('?vue') && filePath.includes('lang.')) {
    return true;
  }

  return false;
}

/**
 * 默认指定文件为 commonjs 和 es 两种 js规范语法
 * @param fileRelativePath 文件的相对根目录的路径格式为 src/test.js 或者 test.js
 * @param options 参考 BuildFileOptions interface
 */
export async function transformFile(fileRelativePath: string, options: BuildFilesOptions = {}) {
  const {
    buildOptions,
    rollupOptionsOutput,
    rollupOptionsExternal,
    singleFileBuildSuccessCallback,
    viteConfig,
    pluginHooks = {},
    formats = ['cjs', 'es'],
    watch = null,
  } = options;

  const lastBuildOptions = typeof buildOptions === 'function' ? buildOptions(fileRelativePath) : buildOptions;

  const extname = path.extname(fileRelativePath);
  let transformFilePath: string;

  if (['.vue', '.svelte'].includes(extname)) {
    transformFilePath = `${fileRelativePath.replace(/[^/]*\//, '')}.js`;
  } else {
    transformFilePath = fileRelativePath.replace(/[^/]*\//, '').replace(extname, '.js');
  }

  const lastRollupOptionsOutput =
    typeof rollupOptionsOutput === 'function' ? rollupOptionsOutput(transformFilePath) : rollupOptionsOutput;
  let lastRollupOptionsExternal = rollupOptionsExternal as ExternalOption;

  if (typeof rollupOptionsExternal === 'function' || typeof rollupOptionsExternal === 'undefined') {
    lastRollupOptionsExternal = (id: string, importer: string | undefined, isResolved?: boolean) => {
      if (rollupOptionsExternal) {
        return rollupOptionsExternal(id, importer, isResolved, fileRelativePath);
      }

      function isAsset() {
        return (
          id.includes('.sass') ||
          id.includes('.scss') ||
          id.includes('.less') ||
          id.includes('.css') ||
          id.includes('.svg')
        );
      }

      function isJson() {
        return id.includes('.json');
      }

      if (
        isJson() ||
        isAsset() ||
        isVueTempFile(id) ||
        // 由于 id 会输出两次（原因未知），windows 下的两次路径还不一致，所以要特殊处理
        // 注意 path.normaLize 和 vite.normalizePath 的行为是不一样的
        path.normalize(id) === path.resolve(process.cwd(), fileRelativePath)
      ) {
        return false;
      }
      return true;
    };
  }

  interface CreateBuildConfigOptions {
    outputDir: string;
    format: OutputOptions['format'];
  }
  function createBuildConfig(options: CreateBuildConfigOptions): InlineConfig {
    const { outputDir, format } = options;
    const lastPluginHooks = Object.keys(pluginHooks).reduce((acc, cur) => {
      if (typeof pluginHooks[cur] === 'function') {
        acc[cur] = pluginHooks[cur];
      }
      return acc;
    }, {});

    const buildConfig = mergeConfig(
      {
        assetsDir: './',
        cssCodeSplit: true,
        emptyOutDir: false,
        rollupOptions: {
          external: lastRollupOptionsExternal,
          output: [
            {
              entryFileNames: path.basename(transformFilePath),
              format,
              indent: false,
              assetFileNames: '[name].[ext]',
              inlineDynamicImports: true,
              ...(lastRollupOptionsOutput as any),
              dir: path.dirname(path.resolve(outputDir, transformFilePath)),
            },
          ],
        },
        lib: {
          // lib 配置只是为了防止 vite 报错，配置 rollupOptions.output 为数组的时候，已经无效。
          formats: ['cjs'],
          entry: path.resolve(process.cwd(), fileRelativePath),
          name: 'noop', // 这里设置只有在 UMD 格式才有效，避免验证报错才设置的，在这里没用
        },
        minify: false,
        watch,
      },
      lastBuildOptions,
    );

    return {
      ...viteConfig,
      plugins: [
        {
          name: 'vite:build-file-transform',
          enforce: 'pre',
          ...lastPluginHooks,
        },
        ...(viteConfig?.plugins ? viteConfig.plugins : []),
      ],
      mode: 'production',
      configFile: false,
      logLevel: 'error',
      build: buildConfig,
    };
  }

  async function lastBuild(options: CreateBuildConfigOptions) {
    const output = await build(createBuildConfig(options));
    if (Array.isArray(output)) {
      // 赋值转换的文件路径，输出打包信息 reporter  会用到
      output.forEach((o) => {
        if (Array.isArray(o.output)) {
          o.output.forEach((oi) => {
            // @ts-ignore
            oi.outputFilePath = `${options.outputDir}/${transformFilePath}`;
          });
        }
      });
    }

    return output;
  }

  await Promise.all(
    formats
      .map((format) => {
        if (typeof format === 'string') {
          format = { format, outDir: format };
        }

        return lastBuild({ outputDir: format.outDir, format: format.format });
      })
      .filter(Boolean),
  );

  incrementCount += 1;
  singleFileBuildSuccessCallback?.(incrementCount, fileRelativePath);

  return fileRelativePath;
}

export type Format = 'cjs' | 'es' | { format: 'cjs' | 'es'; outDir: string };
export interface BuildFilesOptions {
  /**
   * 输入文件夹，相对于项目根目录下，格式为 `src` 或者 `src/test`
   * @defaults src
   */
  inputFolder?: string;
  /**
   * 转换的格式，只支持 es 和 cjs
   * @defaults [{ format: 'cjs', outDir: commonJsOutputDir }, { format: 'es', outDir: esOutputDir }]
   */
  formats?: Format[];
  /**
   * 设置监听构建，同 vite build.watch
   */
  watch?: BuildOptions['watch'];
  /**
   * 支持转换的文件后缀名
   * @defaults ['ts', 'tsx', 'js', 'jsx', 'vue', 'svelte']
   */
  extensions?: string[];
  /**
   * es 文件输出路径，设置为 false 相当于关闭 es 模块的构建
   * v0.6 版本以上，请使用 formats 来设置输出目录，formats 优先级更高
   * @defaults es
   */
  esOutputDir?: string | false;
  /**
   * commonjs 文件输出路径，设置为 false 相当于关闭 commonjs 模块的构建
   * v0.6 版本以上，请使用 formats 来设置输出目录，formats 优先级更高
   * @defaults lib
   */
  commonJsOutputDir?: string | false;
  /**
   * 忽略的转换文件，只支持 glob 语法
   * @defaults ['\*\*\/\*.spec.\*', '\*\*\/\*.test.\*', '\*\*\/\*.d.ts']
   */
  ignoreInputs?: string[];
  /**
   * 此配置会覆盖所有当前构建中 vite config 中 build 配置，
   * 建议优先使用 rollupOptionsOutput、rollupOptionsExternal等其他字段配置
   * 支持函数，第一个参数是入口文件路径
   */
  buildOptions?: BuildOptions | ((inputFilePath: string) => BuildOptions);
  /**
   * 和 rollup output 配置一致，会同时作用在 commonjs 和 es output 配置
   * 支持函数，第一个参数是转换的文件路径
   */
  rollupOptionsOutput?: OutputOptions | ((outputFilePath: string) => OutputOptions);
  /**
   * 和 rollup external 配置一致，
   * 由于 external 不能把自身归属于外部依赖，所以函数模式的参数增加了第四个参数：入口文件相对路径
   * 重新定义 external 需要这样判断：if(id.includes(path.resolve(fileRelativePath))) { return false }
   */
  rollupOptionsExternal?:
    | (string | RegExp)[]
    | string
    | RegExp
    | ((
        source: string,
        importer: string | undefined,
        isResolved: boolean,
        inputFilePath: string,
      ) => boolean | null | void);
  /**
   * vite 配置，内置字段，请不要使用此字段
   */
  viteConfig?: UserConfig;
  /**
   * 单个文件构建成功后的回调
   * @param incrementCount 当前构建成功的递增统计数
   * @param fileRelativePath 当前构建的文件相对根目录的路径
   */
  singleFileBuildSuccessCallback?: (incrementCount: number, fileRelativePath: string) => void;
  /**
   * 构建开始钩子函数，第一个参数 totalFilesCount 是转换文件的总数
   * @param totalFilesCount 所有转换的文件数量
   */
  startBuild?: (totalFilesCount: number) => void;
  /**
   * 所有构建结束钩子函数
   * @param totalFilesCount 所有转换的文件数量
   */
  endBuild?: (totalFilesCount: number) => void;
  /**
   * 插件钩子函数，请不要使用此字段
   */
  pluginHooks?: Plugin;
}

/**
 * 默认转换根目录 src 文件夹下所有 js、ts、jsx、tsx、vue、sevele 文件为 commonjs 和 es 两种 js规范语法
 * @param options 参考 BuildFileOptions interface
 */
export async function buildFiles(options: BuildFilesOptions = {}) {
  const {
    inputFolder = 'src',
    extensions = ['ts', 'tsx', 'js', 'jsx', 'vue', 'svelte'],
    ignoreInputs,
    startBuild,
    endBuild,
    ...restOptions
  } = options;
  // 获取默认为项目根目录下 src 文件夹包括子文件夹的所有 js、ts、jsx、tsx、vue、sevele 文件路径，除开 .test.*、.spec.* 和 .d.ts 三种后缀名的文件
  // 返回格式为 ['src/**/*.ts', 'src/**/*.tsx']
  const srcFilePaths = fg.sync([`${inputFolder}/**/*.{${extensions.join(',')}}`], {
    ignore: ignoreInputs || [`**/*.spec.*`, '**/*.test.*', '**/*.d.ts', '**/__tests__/**'],
  });

  incrementCount = 0;
  startBuild?.(srcFilePaths.length);
  await runInTaskPool(
    srcFilePaths,
    (fileRelativePath: string) => {
      return transformFile(fileRelativePath, restOptions);
    },
    {
      // 同时转换的问题件限制为 20 个
      limit: 20,
    },
  ).then((result) => {
    if (result.hasPartialError) {
      console.error(colors.red('部分文件构建出错'));
    }
  });
  endBuild?.(incrementCount);
  incrementCount = 0; // 重置
}
