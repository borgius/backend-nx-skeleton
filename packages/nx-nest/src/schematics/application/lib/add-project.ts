import { join, normalize } from '@angular-devkit/core'
import { Rule } from '@angular-devkit/schematics'
import { generateProjectLint, updateWorkspaceInTree } from '@nrwl/workspace'

import { NormalizedSchema } from '../schema'

export function addProject (options: NormalizedSchema): Rule {
  return updateWorkspaceInTree((json) => {
    const architect: { [key: string]: any } = {}

    architect.build = {
      builder: '@nrwl/web:build',
      options: {
        outputPath: join(normalize('dist'), options.appProjectRoot),
        index: join(options.appProjectRoot, 'src/index.html'),
        main: join(options.appProjectRoot, 'src/main.tsx'),
        polyfills: join(
          options.appProjectRoot,
          'src/polyfills.ts'
        ),
        tsConfig: join(options.appProjectRoot, 'tsconfig.build.json'),
        assets: [
          join(options.appProjectRoot, 'src/favicon.ico'),
          join(options.appProjectRoot, 'src/assets')
        ],
        scripts: [],
        webpackConfig: '@nrwl/react/plugins/webpack'
      },
      configurations: {
        production: {
          fileReplacements: [
            {
              replace: join(
                options.appProjectRoot,
                'src/environments/environment.ts'
              ),
              with: join(
                options.appProjectRoot,
                'src/environments/environment.prod.ts'
              )
            }
          ],
          optimization: true,
          outputHashing: 'all',
          sourceMap: false,
          extractCss: true,
          namedChunks: false,
          extractLicenses: true,
          vendorChunk: false,
          budgets: [
            {
              type: 'initial',
              maximumWarning: '2mb',
              maximumError: '5mb'
            }
          ]
        }
      }
    }

    architect.serve = {
      builder: '@nrwl/web:dev-server',
      options: {
        buildTarget: `${options.projectName}:build`
      },
      configurations: {
        production: {
          buildTarget: `${options.projectName}:build:production`
        }
      }
    }

    architect.lint = generateProjectLint(
      normalize(options.appProjectRoot),
      join(normalize(options.appProjectRoot), 'tsconfig.app.json'),
      options.linter
    )

    json.projects[options.projectName] = {
      root: options.appProjectRoot,
      sourceRoot: join(options.appProjectRoot, 'src'),
      projectType: 'application',
      schematics: {},
      architect
    }

    json.defaultProject = json.defaultProject || options.projectName

    return json
  })
}
