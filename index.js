const fs = require('fs/promises')
const path = require('path')
const models = require('@risecorejs/core/models')
const prettier = require('prettier')
const { format } = require('date-fns')
const equal = require('deep-equal')
const _ = require('lodash')

const outputPath = path.resolve('database', 'migrations')

void (async () => {
  const metaData = await getMetaData()

  for (const [modelName, model] of Object.entries(models)) {
    if (
      !['Sequelize', 'sequelize'].includes(modelName) &&
      model.options.autoMigrations
    ) {
      try {
        await createMigrations(model)
      } catch (err) {
        console.error('Model:', modelName, err)
      }
    }
  }

  /**
   * CREATE-MIGRATIONS
   * @param model {Class}
   * @return {Promise<void>}
   */
  async function createMigrations(model) {
    const rawMigrations = getRawMigrations(model)

    for (const rawMigration of rawMigrations) {
      const fileName = `${format(new Date(), "yyyy-MM-dd'T'HH-mm-ss")}-${
        rawMigration.label
      }-${model.options.tableName}.js`

      const filePath = outputPath + `/` + fileName

      await fs.writeFile(
        filePath,
        prettier.format(formatMigrationContent(rawMigration.content), {
          trailingComma: 'none',
          tabWidth: 2,
          semi: false,
          singleQuote: true,
          printWidth: 120,
          parser: 'babel'
        })
      )

      console.log('Migration created: ' + fileName)

      await fs.writeFile(
        outputPath + '/meta.json',
        JSON.stringify(metaData, null, 2)
      )
    }
  }

  /**
   * GET-RAW-MIGRATIONS
   * @param model {Class}
   * @return {{label: string, content: string}[]}
   */
  function getRawMigrations(model) {
    const migrations = []

    const modelColumns = getModelColumns(model)

    const metaDataByTableName = metaData[model.options.tableName]

    if (metaDataByTableName) {
      const freezeMetaDataByTableName = Object.freeze(
        JSON.parse(JSON.stringify(metaDataByTableName))
      )

      if (equal(metaDataByTableName, modelColumns)) {
        throw 'no change'
      } else {
        const columns = {
          new: {},
          change: {},
          rename: {},
          remove: []
        }

        for (const [modelColumnName, modelColumnOptions] of Object.entries(
          modelColumns
        )) {
          const currentColumnOptions = metaDataByTableName[modelColumnName]

          if (currentColumnOptions) {
            if (!equal(currentColumnOptions, modelColumnOptions)) {
              columns.change[modelColumnName] = modelColumnOptions

              metaDataByTableName[modelColumnName] = modelColumnOptions
            }
          } else if (modelColumnOptions.prevColumnName) {
            const currentColumnOptions =
              metaDataByTableName[modelColumnOptions.prevColumnName]

            if (
              currentColumnOptions &&
              modelColumnName !== modelColumnOptions.prevColumnName
            ) {
              columns.rename[modelColumnName] = modelColumnOptions

              delete metaDataByTableName[modelColumnOptions.prevColumnName]

              metaDataByTableName[modelColumnName] = modelColumnOptions
            }
          } else {
            columns.new[modelColumnName] = modelColumnOptions

            metaDataByTableName[modelColumnName] = modelColumnOptions
          }

          if (currentColumnOptions) {
            currentColumnOptions.nextColumnName = modelColumnName
          }
        }

        for (const [currentColumnName, currentColumnOptions] of Object.entries(
          metaDataByTableName
        )) {
          if (
            !modelColumns[currentColumnName] &&
            !modelColumns[currentColumnOptions.nextColumnName]
          ) {
            delete metaDataByTableName[currentColumnName]

            columns.remove.push(currentColumnName)
          }

          delete currentColumnOptions.nextColumnName
        }

        if (!_.isEmpty(columns.new)) {
          const columnNames = Object.keys(columns.new)

          const addColumns = columnNames.map((columnName) => {
            return `await queryInterface.addColumn('${
              model.options.tableName
            }', '${columnName}', ${JSON.stringify(
              columns.new[columnName],
              null,
              2
            )})`
          })

          const removeColumns = columnNames.map((columnName) => {
            return `await queryInterface.removeColumn('${model.options.tableName}', '${columnName}')`
          })

          migrations.push({
            label: columnNames.length > 1 ? 'add-columns-to' : 'add-column-to',
            content: `module.exports = {
              async up(queryInterface, DataTypes) {
                ${addColumns.join(';')}
              },
              async down(queryInterface, DataTypes) {
                ${removeColumns.join(';')}
              }
            }`
          })
        }

        if (!_.isEmpty(columns.change)) {
          const columnNames = Object.keys(columns.change)

          const changeColumns = {
            up: columnNames.map(
              (columnName) =>
                `await queryInterface.changeColumn('${
                  model.options.tableName
                }', '${columnName}', ${JSON.stringify(
                  columns.change[columnName],
                  null,
                  2
                )})`
            ),
            down: columnNames.map(
              (columnName) =>
                `await queryInterface.changeColumn('${
                  model.options.tableName
                }', '${columnName}', ${JSON.stringify(
                  freezeMetaDataByTableName[columnName],
                  null,
                  2
                )})`
            )
          }

          migrations.push({
            label:
              columnNames.length > 1 ? 'change-columns-to' : 'change-column-to',
            content: `module.exports = {
              async up(queryInterface, DataTypes) {
                ${changeColumns.up.join(';')}
              },
              async down(queryInterface, DataTypes) {
                ${changeColumns.down.join(';')}
              }
            }`
          })
        }

        if (!_.isEmpty(columns.rename)) {
          const columnNames = Object.keys(columns.rename)

          const renameColumns = {
            up: columnNames.map(
              (columnName) =>
                `await queryInterface.renameColumn('${
                  model.options.tableName
                }', '${
                  modelColumns[columnName].prevColumnName
                }', '${columnName}', ${JSON.stringify(
                  columns.rename[columnName],
                  null,
                  2
                )})`
            ),
            down: columnNames.map(
              (columnName) =>
                `await queryInterface.renameColumn('${
                  model.options.tableName
                }', '${columnName}', '${
                  modelColumns[columnName].prevColumnName
                }', ${JSON.stringify(
                  freezeMetaDataByTableName[
                    modelColumns[columnName].prevColumnName
                  ],
                  null,
                  2
                )})`
            )
          }

          migrations.push({
            label:
              columnNames.length > 1 ? 'rename-columns-to' : 'rename-column-to',
            content: `module.exports = {
              async up(queryInterface, DataTypes) {
                ${renameColumns.up.join(';')}
              },
              async down(queryInterface, DataTypes) {
                ${renameColumns.down.join(';')}
              }
            }`
          })
        }

        if (columns.remove.length) {
          const removeColumns = columns.remove.map((columnName) => {
            return `await queryInterface.removeColumn('${model.options.tableName}', '${columnName}')`
          })

          const addColumns = columns.remove.map((columnName) => {
            return `await queryInterface.addColumn('${
              model.options.tableName
            }', '${columnName}', ${JSON.stringify(
              freezeMetaDataByTableName[columnName],
              null,
              2
            )})`
          })

          migrations.push({
            label:
              columns.remove.length > 1
                ? 'remove-columns-from'
                : 'remove-column-from',
            content: `module.exports = {
              async up(queryInterface, DataTypes) {
                ${removeColumns.join(';')}
              },
              async down(queryInterface, DataTypes) {
                ${addColumns.join(';')}
              }
            }`
          })
        }
      }
    } else {
      metaData[model.options.tableName] = modelColumns

      migrations.push({
        label: 'initial',
        content: `module.exports = {
          async up(queryInterface, DataTypes) {
            await queryInterface.createTable('${
              model.options.tableName
            }', ${JSON.stringify(modelColumns, null, 2)})
          },
          async down(queryInterface) {
            await queryInterface.dropTable('${model.options.tableName}')
          }
        }`
      })
    }

    return migrations
  }
})()

/**
 * GET-META-DATA
 * @return {Promise<Object>}
 */
async function getMetaData() {
  try {
    return require(outputPath + '/meta.json')
  } catch (_) {
    await fs.writeFile(outputPath + '/meta.json', '{}')

    return {}
  }
}

/**
 * GET-MODEL-COLUMNS
 * @param model {Class}
 * @return {Object}
 */
function getModelColumns(model) {
  const baseColumns = {
    id: {
      type: 'DataTypes.INTEGER',
      allowNull: false,
      autoIncrement: true,
      primaryKey: true
    },
    createdAt: {
      type: 'DataTypes.DATE',
      allowNull: false
    },
    updatedAt: {
      type: 'DataTypes.DATE',
      allowNull: false
    },
    deletedAt: {
      type: 'DataTypes.DATE'
    }
  }

  const columns = {}

  const attributes = model.getAttributes()

  if (attributes.id) {
    columns['id'] = baseColumns.id
  }

  for (const [modelColumnName, modelColumnOptions] of Object.entries(
    attributes
  )) {
    if (!Object.keys(baseColumns).includes(modelColumnName)) {
      const TYPE = modelColumnOptions.type.constructor.name

      if (TYPE !== 'VIRTUAL') {
        columns[modelColumnOptions.field] = {
          type: `DataTypes.${TYPE}`,
          allowNull: modelColumnOptions.allowNull === false ? false : void 0,
          unique: modelColumnOptions.unique,
          primaryKey: modelColumnOptions.primaryKey,
          prevColumnName: modelColumnOptions.prevColumnName,
          defaultValue: modelColumnOptions.defaultValue
        }
      }
    }
  }

  if (model.options.timestamps) {
    Object.assign(columns, {
      createdAt: baseColumns.createdAt,
      updatedAt: baseColumns.updatedAt
    })
  }

  if (model.options.paranoid) {
    columns['deletedAt'] = baseColumns.deletedAt
  }

  return JSON.parse(JSON.stringify(columns))
}

/**
 * FORMAT-MIGRATION-CONTENT
 * @param migrationContent {string}
 * @return {string}
 */
function formatMigrationContent(migrationContent) {
  const matchedTypes = [
    ...migrationContent.matchAll(new RegExp('"type":\\s+("DataTypes.+")', 'g'))
  ]

  const formattedTypes = [...new Set(matchedTypes.map(([, type]) => type))]

  for (const type of formattedTypes) {
    migrationContent = migrationContent.replaceAll(
      type,
      type.replaceAll('"', '')
    )
  }

  return migrationContent
}
