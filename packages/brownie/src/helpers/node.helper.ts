import { BaseCommand } from '@cenk1cenk2/boilerplate-oclif'
import { PackageVersions } from '@webundsoehne/nx-tools'
import execa from 'execa'
import { readJson, stat } from 'fs-extra'
import { ListrTask } from 'listr2'
import { join } from 'path'
import through from 'through'
import notifier from 'update-notifier'

import {
  AvailablePackageManagers,
  CheckIfModuleInstalled,
  NodeHelperCtx,
  PackageManagerActions,
  PackageManagerCommands,
  PackageManagerDependencyTypes,
  PackageManagerUsableCommands
} from './node.helper.interface'

export class NodeHelper {
  public globalFolder: string[]
  private ctx: NodeHelperCtx = { fail: {} }
  private manager: AvailablePackageManagers

  constructor (private readonly cmd: BaseCommand) {
    Object.values(AvailablePackageManagers).forEach((m) => {
      try {
        execa.sync(m, [ '--version' ], {
          shell: true,
          stdio: [ 'ignore', 'ignore', 'ignore' ]
        })
      } catch {
        cmd.logger.debug(`Package manager not found: ${m}`)
        this.ctx.fail[m] = true
      }
    })

    this.manager = !this.ctx.fail?.yarn ? AvailablePackageManagers.YARN : AvailablePackageManagers.NPM
    cmd.logger.debug(`NodeHelper initiated with package manager: ${this.manager}`)
  }

  // package manager task itself
  public packageManager (options: PackageManagerActions, packages: string[]): ListrTask {
    return this.cmd.tasks.indent(
      [
        {
          title: 'Working on dependencies...',
          task: async (_, task): Promise<void> => {
            // packages to install
            try {
              // parse according to package manager and type
              const command: string[] = []

              const argumentParser = [
                { condition: options.global, arg: PackageManagerUsableCommands.GLOBAL },
                { condition: options.action === PackageManagerUsableCommands.ADD, arg: PackageManagerUsableCommands.ADD },
                { condition: options.action === PackageManagerUsableCommands.REMOVE, arg: PackageManagerUsableCommands.REMOVE },
                { condition: options.type === PackageManagerDependencyTypes.DEVELOPMENT, arg: PackageManagerUsableCommands.DEVELOPMENT }
              ]

              argumentParser.forEach((a) => {
                if (a.condition) {
                  command.push(PackageManagerCommands[this.manager][a.arg])
                }
              })

              const logOut = through((chunk: Buffer | string) => {
                task.output = chunk?.toString('utf-8').trim()
              })

              // do the action
              const instance = execa(this.manager, [ ...command, ...packages ], { stdio: 'inherit', shell: true })
              instance.stdout.pipe(logOut)
              instance.stderr.pipe(logOut)
              await instance
            } catch (e) {
              throw new Error(`There were errors with ${this.manager} while processing dependencies "${packages.join(', ')}".\n${e.stderr}`)
            }
          }
        }
      ],
      {
        concurrent: false,
        rendererOptions: { collapse: false }
      }
    )
  }

  public async checkIfModuleInstalled (
    pkg: string | string[],
    options?: { global?: boolean, cwd?: string | string[], getVersion?: boolean, getUpdate?: boolean }
  ): Promise<CheckIfModuleInstalled[]> {
    // get the global modules folder with trickery
    if (options?.global) {
      if (!this.globalFolder) {
        const yarnGlobalFolder = join(
          (await execa(AvailablePackageManagers.YARN, [ PackageManagerCommands[AvailablePackageManagers.YARN][PackageManagerUsableCommands.GLOBAL], 'dir' ])).stdout,
          'node_modules'
        )
        const yarnLinkFolder = join(yarnGlobalFolder, '../../', 'link')
        const npmGlobalFolder = join(
          (await execa(AvailablePackageManagers.NPM, [ PackageManagerCommands[AvailablePackageManagers.NPM][PackageManagerUsableCommands.GLOBAL], 'root' ])).stdout
        )
        this.globalFolder = [ npmGlobalFolder, yarnGlobalFolder, yarnLinkFolder ]
      }

      options.cwd = this.globalFolder
    }

    // set default cwd
    if (!options?.cwd) {
      options.cwd = process.cwd()
    }

    // better to have cwd as array
    if (!Array.isArray(options.cwd)) {
      options.cwd = [ options.cwd ]
    }

    if (!Array.isArray(pkg)) {
      pkg = [ pkg ]
    }

    // ugly function need refactoring
    return Promise.all(
      pkg.map(async (p) => {
        const o = { pkg: p, installed: false } as CheckIfModuleInstalled
        await Promise.all(
          (options.cwd as string[]).map(async (v) => {
            try {
              const packagePath = join(v, p)

              ;(await stat(packagePath)).isDirectory()
              o.installed = true

              // get version from stuff
              const packageJson = join(packagePath, 'package.json')
              if (options.getVersion) {
                try {
                  o.version = (await readJson(packageJson))?.version
                } catch {
                  this.cmd.logger.debug(`Can not read package version of package: ${p}`)
                }
              }
              // dont care about the catch case since this will look at multiple cwds
              // eslint-disable-next-line no-empty
            } catch {}
          })
        )

        // get updates if available
        if (o?.version && options?.getUpdate) {
          try {
            const updatable = await notifier({ pkg: { name: o.pkg, version: o.version } }).fetchInfo()

            if (updatable.type !== 'latest') {
              o.hasUpdate = true
              o.updateType = `${updatable.type}: ${updatable.current} -> ${updatable.latest}`
            } else {
              o.hasUpdate = false
            }
          } catch (e) {
            this.cmd.logger.debug(`Can not check for current version: ${p}`)
          }
        }

        return o
      })
    )
  }

  public parseDependencies (deps: PackageVersions): { prod: string[], dev: string[] } {
    const prod: string[] = []
    const dev: string[] = []

    if (deps.deps) {
      prod.push(...Object.entries(deps.deps).map((p, v) => `${p}@${v}`))
    }
    if (deps.devDeps) {
      dev.push(...Object.entries(deps.devDeps).map((p, v) => `${p}@${v}`))
    }

    return { prod, dev }
  }
}
