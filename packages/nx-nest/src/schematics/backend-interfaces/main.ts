import { chain, Rule, SchematicContext, Tree } from '@angular-devkit/schematics'

import { addProject } from './lib/add-project'
import { createApplicationFiles } from './lib/create-application-files'
import { normalizeOptions } from './lib/normalize-options'
import { updateIntegration } from './lib/update-integration'
import { Schema } from './main.interface'
import { SchematicConstants } from '@src/interfaces'
import { addEslintConfigRule, eslintJson, formatTreeRule, LINTER_VERSIONS, Logger, runInRule, updateTsConfigPathsRule } from '@webundsoehne/nx-tools'

export default function (schema: Schema): (host: Tree, context: SchematicContext) => Promise<Rule> {
  return async (host: Tree, context: SchematicContext): Promise<Rule> => {
    const log = new Logger(context)
    const options = await normalizeOptions(host, context, schema)

    return chain([
      runInRule(log.info.bind(log)(`Adding ${SchematicConstants.BACKEND_INTERFACES_PACKAGE} library to workspace.`)),

      addEslintConfigRule(options, { deps: LINTER_VERSIONS.eslint, json: eslintJson({ packageScope: options.packageScope }) }),

      addProject(options),

      runInRule(log.info.bind(log)('Creating application files.')),
      createApplicationFiles(options),

      runInRule(log.info.bind(log)('Updating integration.')),
      updateIntegration(options),

      runInRule(log.info.bind(log)('Updating tsconfig files.')),
      updateTsConfigPathsRule(options),

      formatTreeRule({ skip: options.skipFormat })
    ])
  }
}
