import { promises as fs } from 'fs'
import * as path from 'path'
import type { Observable } from 'rxjs'
import { of } from 'rxjs'
import { combineLatest, defer } from 'rxjs'
import { switchMap } from 'rxjs/operators'
import type { PackageJson } from 'type-fest'

import type { Cache } from '..'
import type { SourcePlugin, SourcePluginType } from '../plugin'
import type { SchemaDef } from '../schema'
import { makeArtifactsDir } from '../utils'
import { renderDocumentOrObjectDef } from './generate-types'

export const generateDotpkg = ({
  source,
  watchData,
}: {
  source: SourcePlugin
  watchData: boolean
}): Observable<void> => {
  return combineLatest({
    cache: source.fetchData({ watch: watchData, force: true, previousCache: undefined }),
    schemaDef: defer(async () => source.provideSchema()),
    targetPath: defer(async () => makeArtifactsDir()),
    sourcePluginType: of(source.type),
  }).pipe(switchMap(generateForCache))
}

const generateForCache = async ({
  cache,
  schemaDef,
  targetPath,
  sourcePluginType,
}: {
  schemaDef: SchemaDef
  cache: Cache
  targetPath: string
  sourcePluginType: SourcePluginType
}): Promise<void> => {
  const withPrefix = (...path_: string[]) => path.join(targetPath, ...path_)

  const dataFiles = Object.values(schemaDef.documentDefMap).map((docDef) => ({
    name: docDef.name,
    content: makeDocumentDataFile({
      typeName: docDef.name,
      data: cache.documents.filter((_) => _._typeName === docDef.name),
    }),
  }))

  await Promise.all([mkdir(withPrefix('types')), mkdir(withPrefix('data'))])

  await Promise.all([
    generateFile({ filePath: withPrefix('package.json'), content: makePackageJson() }),
    generateFile({ filePath: withPrefix('types', 'index.d.ts'), content: makeTypes({ schemaDef, sourcePluginType }) }),
    generateFile({ filePath: withPrefix('data', 'index.d.ts'), content: makeDataTypes({ schemaDef }) }),
    generateFile({ filePath: withPrefix('data', 'index.js'), content: makeIndexJs({ schemaDef }) }),
    ...dataFiles.map(({ name, content }) => generateFile({ filePath: withPrefix('data', `all${name}.js`), content })),
  ])
}

const makePackageJson = (): string => {
  const packageJson: PackageJson & { typesVersions: any } = {
    name: 'dot-contentlayer',
    description: 'This package is auto-generated by Contentlayer',
    version: '0.0.0',
    exports: {
      './data': {
        import: './data/index.js',
      },
    },
    typesVersions: {
      '*': {
        data: ['./data'],
        types: ['./types'],
      },
    },
  }

  return JSON.stringify(packageJson)
}

const mkdir = async (dirPath: string) => {
  try {
    await fs.mkdir(dirPath)
  } catch (e) {
    if (e.code !== 'EEXIST') {
      throw e
    }
  }
}

const generateFile = async ({ filePath, content }: { filePath: string; content: string }): Promise<void> => {
  await fs.writeFile(filePath, content, 'utf8')
}

const makeDocumentDataFile = ({ typeName, data }: { typeName: string; data: any[] }): string => {
  return `\
export const all${typeName} = ${JSON.stringify(data, null, 2)}
`
}

const makeIndexJs = ({ schemaDef }: { schemaDef: SchemaDef }): string => {
  const typeNames = Object.keys(schemaDef.documentDefMap)
  const constReexports = typeNames.map((typeName) => `export * from './all${typeName}.js'`).join('\n')

  const constImports = typeNames.map((typeName) => `import { all${typeName} } from './all${typeName}.js'`).join('\n')

  return `\
export { isType } from 'contentlayer/client'

${constReexports}
${constImports}

export const allDocuments = [${typeNames.map((typeName) => `...all${typeName}`).join(', ')}]
`
}

const makeTypes = ({
  schemaDef,
  sourcePluginType,
}: {
  schemaDef: SchemaDef
  sourcePluginType: SourcePluginType
}): string => {
  const documentTypes = Object.values(schemaDef.documentDefMap)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((docDef) => ({
      typeName: docDef.name,
      typeDef: renderDocumentOrObjectDef({ def: docDef, sourcePluginType }),
    }))

  const objectTypes = Object.values(schemaDef.objectDefMap)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((objDef) => ({
      typeName: objDef.name,
      typeDef: renderDocumentOrObjectDef({ def: objDef, sourcePluginType }),
    }))

  const typeMap = documentTypes
    .map((_) => _.typeName)
    .map((_) => `  ${_}: ${_}`)
    .join('\n')

  return `\
// NOTE This file is auto-generated by the Contentlayer CLI
import type { Markdown } from 'contentlayer/core'
export { isType } from 'contentlayer/client'

export type Image = string
export type { Markdown }

export interface ContentlayerGenTypes {
  documentTypes: DocumentTypes
  documentTypeMap: DocumentTypeMap
  documentTypeNames: DocumentTypeNames
  allTypeNames: AllTypeNames
}

declare global {
  interface ContentlayerGen extends ContentlayerGenTypes {}
}

export type DocumentTypeMap = {
${typeMap}
}

export type AllTypes = DocumentTypes | ObjectTypes
export type AllTypeNames = DocumentTypeNames | ObjectTypeNames

export type DocumentTypes = ${documentTypes.map((_) => _.typeName).join(' | ')}
export type DocumentTypeNames = DocumentTypes['_typeName']

export type ObjectTypes = ${objectTypes.length > 0 ? objectTypes.map((_) => _.typeName).join(' | ') : 'never'}
export type ObjectTypeNames = ObjectTypes['_typeName']



/** Document types */
${documentTypes.map((_) => _.typeDef).join('\n\n')}  

/** Object types */
${objectTypes.map((_) => _.typeDef).join('\n\n')}  
  
 `
}

const makeDataTypes = ({ schemaDef }: { schemaDef: SchemaDef }): string => {
  const dataConsts = Object.keys(schemaDef.documentDefMap)
    .map((typeName) => `export declare const all${typeName}: ${typeName}[]`)
    .join('\n')

  return `\
// NOTE This file is auto-generated by the Contentlayer CLI
import { ${Object.keys(schemaDef.documentDefMap).join(', ')}, DocumentTypes } from '../types'

${dataConsts}

export declare const allDocuments: DocumentTypes[]

`
}
