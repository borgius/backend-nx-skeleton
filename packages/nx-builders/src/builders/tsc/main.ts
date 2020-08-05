/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { BuilderContext, BuilderOutput, createBuilder } from '@angular-devkit/architect'
import { fs } from '@angular-devkit/core/node'
import { readJsonFile } from '@nrwl/workspace'
import { readPackageJson } from '@nrwl/workspace/src/core/file-utils'
import { createProjectGraph, ProjectGraph } from '@nrwl/workspace/src/core/project-graph'
import {
  calculateProjectDependencies,
  checkDependentProjectsHaveBeenBuilt,
  createTmpTsConfig,
  DependentBuildableProjectNode,
  updateBuildableProjectPackageJsonDependencies
} from '@nrwl/workspace/src/utils/buildable-libs-utils'
import { writeJsonFile } from '@nrwl/workspace/src/utils/fileutils'
import { ExecaArguments, createDependenciesForProjectFromGraph, Logger, mergeDependencies, pipeProcessToLogger } from '@webundsoehne/nx-tools'
import { SpawnOptions } from 'child_process'
import merge from 'deepmerge'
import execa from 'execa'
import { copy, removeSync } from 'fs-extra'
import glob from 'glob'
import { basename, dirname, join, normalize, relative } from 'path'
import { Observable, of, Subscriber } from 'rxjs'
import { map, switchMap, tap } from 'rxjs/operators'

import { FileInputOutput, NodePackageBuilderOptions, NormalizedBuilderOptions, ProcessPaths } from './main.interface'

export function runBuilder (options: NodePackageBuilderOptions, context: BuilderContext) {
  const projGraph = createProjectGraph()
  const normalizedOptions = normalizeOptions(options, context)
  const { target, dependencies } = calculateProjectDependencies(projGraph, context)

  return of(checkDependentProjectsHaveBeenBuilt(context, dependencies)).pipe(
    switchMap((result) => {
      if (result) {
        return compileFiles(normalizedOptions, context, projGraph, dependencies).pipe(
          tap(() => {
            // update package.json
            updatePackageJson(normalizedOptions, context)

            // this is the default behaviour, lets keep this.
            if (dependencies.length > 0 && options.updateBuildableProjectDepsInPackageJson) {
              updateBuildableProjectPackageJsonDependencies(context, target, dependencies)
            }
          }),
          switchMap(() => copyAssetFiles(normalizedOptions, context))
        )
      } else {
        return of({ success: false })
      }
    }),
    map((value) => {
      return {
        ...value,
        outputPath: normalizedOptions.outputPath
      }
    })
  )
}

function normalizeOptions (options: NodePackageBuilderOptions, context: BuilderContext) {
  const outDir = options.outputPath
  const files: FileInputOutput[] = []

  const globbedFiles = (pattern: string, input = '', ignore: string[] = []): string[] => {
    return glob.sync(pattern, {
      cwd: input,
      nodir: true,
      ignore
    })
  }

  options.assets.forEach((asset) => {
    if (typeof asset === 'string') {
      globbedFiles(asset, context.workspaceRoot).forEach((globbedFile) => {
        files.push({
          input: join(context.workspaceRoot, globbedFile),
          output: join(context.workspaceRoot, outDir, basename(globbedFile))
        })
      })
    } else {
      globbedFiles(asset.glob, join(context.workspaceRoot, asset.input), asset.ignore).forEach((globbedFile) => {
        files.push({
          input: join(context.workspaceRoot, asset.input, globbedFile),
          output: join(context.workspaceRoot, outDir, asset.output, globbedFile)
        })
      })
    }
  })

  // Relative path for the dist directory
  const tsconfig = readJsonFile(join(context.workspaceRoot, options.tsConfig))
  const rootDir = tsconfig.compilerOptions?.rootDir || ''
  const mainFileDir = dirname(options.main)
  const tsconfigDir = dirname(options.tsConfig)

  const relativeMainFileOutput = relative(`${tsconfigDir}/${rootDir}`, mainFileDir)

  return {
    ...options,
    files,
    relativeMainFileOutput,
    normalizedOutputPath: join(context.workspaceRoot, options.outputPath)
  }
}

function compileFiles (
  options: NormalizedBuilderOptions,
  context: BuilderContext,
  projGraph: ProjectGraph,
  projectDependencies: DependentBuildableProjectNode[]
): Observable<BuilderOutput> {
  const logger = new Logger(context)

  // Cleaning the /dist folder
  removeSync(options.normalizedOutputPath)

  const paths: ProcessPaths = {
    typescript: require.resolve('typescript/bin/tsc'),
    tscpaths: require.resolve('tscpaths/cjs/index'),
    'tsc-watch': require.resolve('tsc-watch/lib/tsc-watch'),
    tsconfig: join(context.workspaceRoot, options.tsConfig)
  }

  // have to return a observable here
  return Observable.create(async (subscriber: Subscriber<BuilderOutput>): Promise<void> => {
    if (projectDependencies.length > 0) {
      const libRoot = projGraph.nodes[context.target.project].data.root
      paths.tsconfig = createTmpTsConfig(paths.tsconfig, context.workspaceRoot, libRoot, projectDependencies)
    }

    try {
      // paths of the programs, more convient than using the api since tscpaths does not have api

      // check if needed tools are really installed
      Object.entries(paths).forEach(([ key, value ]) => {
        if (!fs.isFile(value)) {
          subscriber.error(new Error(`${key} is not found.`))
        }
      })

      if (options.watch) {
        // TODO: This part is not working as intended atm
        logger.info('Starting TypeScript-Watch')

        logger.debug(`Typescript path: ${paths.typescript}`)

        const { args, spawnOptions } = normalizeArguments(options, context, paths, 'typescript')

        await Promise.all([
          execa.node(paths.typescript, args, spawnOptions),
          execa.node(normalize(`./${options.relativeMainFileOutput}/${basename(options.main, '.ts')}.js`), [], {
            ...spawnOptions,
            cwd: join(context.workspaceRoot, options.outputPath)
          })
        ])
      } else {
        // the normal mode of compiling
        logger.info('Transpiling TypeScript files...')

        logger.debug(`typescript path: ${paths.typescript}`)

        const { args, spawnOptions } = normalizeArguments(options, context, paths, 'typescript')

        await pipeProcessToLogger(context, execa.node(paths.typescript, args, spawnOptions))

        logger.info('Transpiling to TypeScript is done.')
      }

      // optional swap paths, which will swap all the typescripts to relative paths.
      if (options.swapPaths) {
        if (!fs.isFile(paths.tscpaths)) {
          subscriber.error(new Error('TSCPaths is not found.'))
        }

        logger.info('Swapping Typescript paths...')

        logger.debug(`tscpaths path: ${paths.tscpaths}`)

        // create temporary tsconfig.paths
        const tsconfig = readJsonFile(paths.tsconfig)

        writeJsonFile(paths.tsconfig, merge(tsconfig, { compilerOptions: { baseUrl: join(context.workspaceRoot, options.outputPath) } }))

        const { args, spawnOptions } = normalizeArguments(options, context, paths, 'tscpaths')

        await pipeProcessToLogger(context, execa.node(paths.tscpaths, args, spawnOptions))

        logger.info('Swapped TypeScript paths.')
      }

      subscriber.next({ success: true })
    } catch (error) {
      subscriber.error(new Error(`Could not compile Typescript files:\n${error}`))
    } finally {
      subscriber.complete()
    }
  })
}

function normalizeArguments (options: NormalizedBuilderOptions, context: BuilderContext, paths: ProcessPaths, mode: 'typescript' | 'tscpaths'): ExecaArguments {
  let args: string[]
  let spawnOptions: SpawnOptions
  spawnOptions = { stdio: 'inherit' }

  if (mode === 'typescript') {
    // arguments for typescript compiler
    args = [ '-p', paths.tsconfig, '--outDir', options.normalizedOutputPath ]

    if (options.sourceMap) {
      args = [ ...args, '--sourceMap' ]
    }

    if (options.verbose) {
      args = [ ...args, '--extendedDiagnostics', '--listEmittedFiles' ]
    }

    if (options.cwd) {
      spawnOptions = { ...spawnOptions, cwd: options.cwd }
    }
  } else if (mode === 'tscpaths') {
    // arguments for tsc paths
    args = [ '-p', paths.tsconfig, '-s', options.outputPath, '-o', options.outputPath ]

    if (options.verbose) {
      args = [ ...args, '--verbose' ]
    }

    spawnOptions = { ...spawnOptions, cwd: context.workspaceRoot }
  }

  return { args, spawnOptions }
}

// function killProcess (context: BuilderContext): void {
//   const logger = new Logger(context)

//   childProcesses.forEach((process, i) => {
//     return treeKill(process.pid, 'SIGTERM', (error) => {

//       if (error) {
//         if (Array.isArray(error) && error[0] && error[2]) {
//           const errorMessage = error[2]
//           logger.error(errorMessage)
//         } else if (error.message) {
//           logger.error(error.message)
//         }

//       } else {
//         delete childProcesses[i]

//       }

//       logger.debug(`Stopped PID: ${process.pid}`)
//     })

//   })
// }

function updatePackageJson (options: NormalizedBuilderOptions, context: BuilderContext) {
  const logger = new Logger(context)

  const mainFile = basename(options.main, '.ts')
  let packageJson = readJsonFile(options.packageJson ?? join(context.workspaceRoot, options.cwd, 'package.json'))

  if (packageJson) {
    logger.warn('No implicit package.json file found for the package. Skipping.')
    return
  }

  const globalPackageJson = readPackageJson()

  // update main file and typings
  packageJson = {
    ...packageJson,
    main: normalize(`./${options.relativeMainFileOutput}/${mainFile}.js`),
    typings: normalize(`./${options.relativeMainFileOutput}/${mainFile}.d.ts`)
  }

  // update implicit dependencies
  const implicitDependencies = {}

  if (packageJson.implicitDependencies) {
    logger.info('Processing implicit dependencies...')

    Object.entries(packageJson.implicitDependencies).forEach(([ name, version ]) => {
      implicitDependencies[name] = version === true ? globalPackageJson.dependencies[name] : version
    })
  }

  delete packageJson.implicitDependencies

  // update package dependencies
  const project = context.target.project
  const graph = createProjectGraph()

  packageJson.dependencies = mergeDependencies(createDependenciesForProjectFromGraph(graph, project), packageJson.dependencies, implicitDependencies)

  // write file back
  writeJsonFile(`${options.outputPath}/package.json`, packageJson)
}

function copyAssetFiles (options: NormalizedBuilderOptions, context: BuilderContext): Promise<BuilderOutput> {
  const logger = new Logger(context)

  logger.info('Copying asset files...')

  return Promise.all(
    options.files.map((file) => {
      logger.debug(`Copying "${file.input}" to ${file.output}`)

      return copy(file.input, file.output)
    })
  )
    .then(() => {
      logger.info('Done copying asset files.')
      return {
        success: true
      }
    })
    .catch((err: Error) => {
      return {
        error: err.message,
        success: false
      }
    })
}

export default createBuilder(runBuilder)