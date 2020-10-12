import { apply, FileEntry, forEach, mergeWith, Rule, SchematicContext, Source, Tree } from '@angular-devkit/schematics'
import * as diff from 'diff'
import { createPrompt } from 'listr2'
import { EOL } from 'os'
import { dirname } from 'path'
import { Observable } from 'rxjs'

import { Logger } from '@utils/index'

// FIXME: branchandmerge bug: https://github.com/angular/angular-cli/issues/11337A
export async function applyOverwriteWithDiff (source: Source, oldSource: Source | void, context: SchematicContext): Promise<Rule> {
  const log = new Logger(context)

  // generate the old tree without aplying something
  let oldTree: Tree

  if (oldSource) {
    try {
      oldTree = await ((oldSource(context) as unknown) as Observable<Tree>).toPromise()
      log.warn('Prior configuration successfully recovered. Will run in diff-patch mode.')
      // eslint-disable-next-line no-empty
    } catch {}
  }

  // angular is not enough for this, need a hacky solution to track the files, because some of them we overwrite directly
  let fileChanges: string[] = []
  let filesToRemove: string[] = []
  let filesToKeep: string[] = []

  return (host: Tree): Rule => {
    return mergeWith(
      apply(source, [
        forEach((file) => {
          if (host.exists(file.path)) {
            const currentFile = host.read(file.path).toString()
            const newFile = file.content.toString()

            if (oldTree?.exists(file.path)) {
              // check if this file is part of old application
              const oldFile = oldTree.read(file.path).toString()

              mergeFiles(host, file, tripleFileMerge(file.path, currentFile, oldFile, newFile, log), log)
            } else {
              mergeFiles(host, file, doubleFileMerge(file.path, newFile, currentFile, log), log)
            }

            // add this to file changes, return null since we did the operation directly
            fileChanges = [ ...fileChanges, file.path ]
            return null
          }

          // vanilla mode
          fileChanges = [ ...fileChanges, file.path ]
          return file
        }),

        // compare current and old configuration to get not needed files
        (): void => {
          oldTree?.visit((path) => {
            // if we dont overwrite the file with filechanges we do not need it, but it exists in tree which is the current host sysstem
            if (host.exists(path) && !fileChanges.includes(path)) {
              filesToRemove = [ ...filesToRemove, path ]
            }
          })
        },

        // ask user if he/she wants to keep files that are not needed anymore
        async (): Promise<void> => {
          if (filesToRemove.length > 0) {
            try {
              filesToKeep = await createPrompt.bind(this)(
                {
                  type: 'MultiSelect',
                  message: 'These files are found to be unnecassary by comparing prior configuration to new configuration. Select the ones to keep.',
                  choices: filesToRemove
                },
                { error: false }
              )
            } catch {
              log.error('Cancelled prompt.')
              process.exit(127)
            }
          }
        },

        // delete not needed files from changing setup
        async (): Promise<void> => {
          if (filesToRemove.length > 0) {
            // get which files to remove
            filesToRemove = filesToRemove.reduce((o, val) => {
              // angular normalizes even path arrays defined outside!
              o = [ ...o, (val as any).path ]
              return o
            }, [])

            // remove that file
            await Promise.all(
              filesToRemove.map((file) => {
                if (!filesToKeep.includes(file)) {
                  log.debug(`Deleting not-needed file: "${file}"`)
                  host.delete(file)
                } else {
                  log.debug(`Keeping not-needed file: "${file}"`)
                }
              })
            )
          }
        },

        // delete empty directories after changes
        async (): Promise<void> => {
          if (filesToRemove.length > 0) {
            // get all directory names of files to remove
            const directories = filesToRemove.map((path) => dirname(path)).filter((item, index, array) => array.indexOf(item) === index)

            // check and delete empty directories
            await Promise.all(
              directories.map(async (directory) => {
                if (host.getDir(directory)?.subfiles?.length === 0 && !(host.getDir(directory)?.subdirs?.length > 0)) {
                  log.debug(`Deleting not-needed empty directory: "${directory}"`)
                  host.delete(directory)
                } else if (host.getDir(directory)?.subdirs?.length > 0) {
                  // dont delete if has subdirectories
                  log.debug(`Still has subdirectories: "${directory}"`)
                }
              })
            )
          }
        }
      ])
    )
  }
}

const context = 1

export function tripleFileMerge (name: string, currentFile: string, oldFile: string, newFile: string, log: Logger): string | boolean {
  let buffer: string
  // create difference-patch
  const patch: string = diff.createPatch(name, oldFile, newFile, '', '', { context })

  try {
    buffer = diff.applyPatch(currentFile, patch)
  } catch (e) {
    log.debug(`Error while triple-merging: ${e}`)
    return false
  }

  log.debug(patch)

  return buffer
}

export function doubleFileMerge (name: string, newFile: string, currentFile: string, log: Logger): string | boolean {
  let buffer: string
  const newToCurrentPatch = selectivePatch(diff.structuredPatch(name, name, currentFile, newFile, '', '', { context }), 'add')

  try {
    buffer = diff.applyPatch(currentFile, newToCurrentPatch)
  } catch (e) {
    log.debug(`Error while double-merging: ${e}`)
    return false
  }
  // const currentToNewPatch = diff.structuredPatch(name, name, file, currentFile, '', '', { context })
  // console.log('currentToNewPatch', currentToNewPatch.hunks)
  // try {
  //   file = diff.applyPatch(newFile, currentToNewPatch)
  // } catch (e) {
  //   log.debug(e)
  //   return false
  // }

  return buffer
}

export function selectivePatch (patch: diff.ParsedDiff, select: 'add' | 'remove'): diff.ParsedDiff {
  return {
    ...patch,
    hunks: [
      ...patch.hunks.map((p) => {
        // reduce instead of map because, i am trying some operations
        // let linechanges = 0
        const lines = p.lines.reduce((o, l) => {
          if (select === 'add') {
            // linechanges++
            return [ ...o, replaceFirstChars(l, '-', ' ') ]
          } else if (select === 'remove') {
            // linechanges++
            return [ ...o, replaceFirstChars(l, '+', ' ') ]
          }
        }, [])

        return {
          ...p,
          linedelimiters: p.lines.map(() => EOL),
          lines
        }
      })
    ]
  }
}

function replaceFirstChars (str: string, from: string, to: string): string {
  if (str.substring(0, from.length) === from) {
    return to + str.substring(from.length)
  } else {
    return str
  }
}

export function mergeFiles (host: Tree, file: FileEntry, mergedFiles: string | boolean, log: Logger): void {
  let buffer = file.content

  if (typeof mergedFiles === 'string') {
    buffer = Buffer.from(mergedFiles, 'utf-8')

    host.overwrite(file.path, buffer)
  } else {
    log.error(`Can not merge file: "${file.path}" -> "${file.path}.old"`)

    createFileBackup(host, file, log)

    host.create(file.path, buffer)
  }
}

export function createFileBackup (host: Tree, file: FileEntry, log: Logger): void {
  const backupFilePath = `${file.path}.old`

  log.error(`Can not merge file: "${file.path}" -> "${backupFilePath}"`)

  if (host.exists(backupFilePath)) {
    host.delete(backupFilePath)
  }

  host.rename(file.path, backupFilePath)
}
