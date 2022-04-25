const fs = require('fs/promises')
const prettier = require('prettier')
const { format } = require('date-fns')
const equal = require('deep-equal')
const _ = require('lodash')
const consola = require('consola')

/**
 * MAKE-MIGRATIONS
 * @param outputPath {string}
 * @param models {Object}
 * @return {Promise<void>}
 */
module.exports = async (outputPath, models) => {
  const metaData = await getMetaData(outputPath)

  for (const [modelName, model] of Object.entries(models)) {
    if (!['Sequelize', 'sequelize'].includes(modelName) && model.options.autoMigrations) {
      try {
        await createMigrations(model, outputPath, metaData)
      } catch (err) {
        if (err === 'no change') {
          consola.info('Model: ' + modelName, err)
        } else {
          consola.error(err)
        }
      }
    }
  }
}

/**
 * CREATE-MIGRATIONS
 * @param model {Class}
 * @param outputPath {string}
 * @param metaData {Object}
 * @return {Promise<void>}
 */
async function createMigrations(model, outputPath, metaData) {
  const rawMigrations = getRawMigrations(model, metaData)

  for (const rawMigration of rawMigrations) {
    const fileTimestamp = format(new Date(), "yyyy-MM-dd'T'HH-mm-ss")
    const filename = `${fileTimestamp}-${rawMigration.label}-${model.options.tableName}.js`
    const filePath = outputPath + `/` + filename

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

    consola.success('Migration created: ' + filename)

    await fs.writeFile(outputPath + '/meta.json', JSON.stringify(metaData, null, 2))
  }
}

/**
 * GET-RAW-MIGRATIONS
 * @param model {Class}
 * @param metaData {Object}
 * @return {{label: string, content: string}[]}
 */
function getRawMigrations(model, metaData) {
  const migrations = []

  const modelColumns = getModelColumns(model)

  const metaDataByTableName = metaData[model.options.tableName]

  if (metaDataByTableName) {
    const freezeMetaDataByTableName = Object.freeze(JSON.parse(JSON.stringify(metaDataByTableName)))

    if (equal(metaDataByTableName, modelColumns)) {
      throw 'no change'
    } else {
      const columns = {
        new: {},
        change: {},
        rename: {},
        remove: []
      }

      for (const [modelColumnName, modelColumnOptions] of Object.entries(modelColumns)) {
        const currentColumnOptions = metaDataByTableName[modelColumnName]

        if (currentColumnOptions) {
          if (!equal(currentColumnOptions, modelColumnOptions)) {
            columns.change[modelColumnName] = modelColumnOptions

            metaDataByTableName[modelColumnName] = modelColumnOptions
          }
        } else if (modelColumnOptions.prevColumnName) {
          const currentColumnOptions = metaDataByTableName[modelColumnOptions.prevColumnName]

          if (currentColumnOptions && modelColumnName !== modelColumnOptions.prevColumnName) {
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

      for (const [currentColumnName, currentColumnOptions] of Object.entries(metaDataByTableName)) {
        if (!modelColumns[currentColumnName] && !modelColumns[currentColumnOptions.nextColumnName]) {
          delete metaDataByTableName[currentColumnName]

          columns.remove.push(currentColumnName)
        }

        delete currentColumnOptions.nextColumnName
      }

      if (!_.isEmpty(columns.new)) {
        const columnNames = Object.keys(columns.new)

        const addColumns = {
          up: [],
          down: []
        }

        for (const columnName of columnNames) {
          addColumns.up.push(
            `await queryInterface.addColumn(
              '${model.options.tableName}',
              '${columnName}',
              ${JSON.stringify(columns.new[columnName], null, 2)}
            )`
          )

          addColumns.down.push(`await queryInterface.removeColumn('${model.options.tableName}', '${columnName}')`)
        }

        migrations.push({
          label: columnNames.length > 1 ? 'add-columns-to' : 'add-column-to',
          content: `module.exports = {
            async up(queryInterface, { DataTypes }) {
              ${addColumns.up.join(';')}
            },
            async down(queryInterface, Sequelize) {
              ${addColumns.down.join(';')}
            }
          }`
        })
      }

      if (!_.isEmpty(columns.change)) {
        const columnNames = Object.keys(columns.change)

        const changeColumns = {
          up: [],
          down: []
        }

        for (const columnName of columnNames) {
          changeColumns.up.push(
            `await queryInterface.changeColumn(
              '${model.options.tableName}',
              '${columnName}',
              ${JSON.stringify(columns.change[columnName], null, 2)}
            )`
          )

          changeColumns.down.push(
            `await queryInterface.changeColumn(
              '${model.options.tableName}',
              '${columnName}',
              ${JSON.stringify(freezeMetaDataByTableName[columnName], null, 2)}
            )`
          )
        }

        migrations.push({
          label: columnNames.length > 1 ? 'change-columns-to' : 'change-column-to',
          content: `module.exports = {
            async up(queryInterface, { DataTypes }) {
              ${changeColumns.up.join(';')}
            },
            async down(queryInterface, Sequelize) {
              ${changeColumns.down.join(';')}
            }
          }`
        })
      }

      if (!_.isEmpty(columns.rename)) {
        const columnNames = Object.keys(columns.rename)

        const renameColumns = {
          up: [],
          down: []
        }

        for (const columnName of columnNames) {
          renameColumns.up.push(
            `await queryInterface.renameColumn(
              '${model.options.tableName}',
              '${modelColumns[columnName].prevColumnName}',
              '${columnName}', ${JSON.stringify(columns.rename[columnName], null, 2)}
            )`
          )

          renameColumns.down.push(
            `await queryInterface.renameColumn(
              '${model.options.tableName}',
              '${columnName}',
              '${modelColumns[columnName].prevColumnName}',
              ${JSON.stringify(freezeMetaDataByTableName[modelColumns[columnName].prevColumnName], null, 2)}
            )`
          )
        }

        migrations.push({
          label: columnNames.length > 1 ? 'rename-columns-to' : 'rename-column-to',
          content: `module.exports = {
            async up(queryInterface, { DataTypes }) {
              ${renameColumns.up.join(';')}
            },
            async down(queryInterface, Sequelize) {
              ${renameColumns.down.join(';')}
            }
          }`
        })
      }

      if (columns.remove.length) {
        const removeColumns = {
          up: [],
          down: []
        }

        for (const columnName of columns.remove) {
          removeColumns.up.push(`await queryInterface.removeColumn('${model.options.tableName}', '${columnName}')`)

          removeColumns.down.push(
            `await queryInterface.addColumn(
              '${model.options.tableName}',
              '${columnName}',
              ${JSON.stringify(freezeMetaDataByTableName[columnName], null, 2)}
            )`
          )
        }

        migrations.push({
          label: columns.remove.length > 1 ? 'remove-columns-from' : 'remove-column-from',
          content: `module.exports = {
            async up(queryInterface, { DataTypes }) {
              ${removeColumns.up.join(';')}
            },
            async down(queryInterface, Sequelize) {
              ${removeColumns.down.join(';')}
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
        async up(queryInterface, { DataTypes }) {
          await queryInterface.createTable(
            '${model.options.tableName}',
            ${JSON.stringify(modelColumns, null, 2)}
          )
        },
        async down(queryInterface, Sequelize) {
          await queryInterface.dropTable('${model.options.tableName}')
        }
      }`
    })
  }

  return migrations
}

/**
 * GET-META-DATA
 * @param outputPath {string}
 * @return {Promise<Object>}
 */
async function getMetaData(outputPath) {
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

  for (const [modelColumnName, modelColumnOptions] of Object.entries(attributes)) {
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
  const matchedTypes = [...migrationContent.matchAll(new RegExp('"type":\\s+("DataTypes.+")', 'g'))]

  const formattedTypes = [...new Set(matchedTypes.map(([, type]) => type))]

  for (const type of formattedTypes) {
    migrationContent = migrationContent.replaceAll(type, type.replaceAll('"', ''))
  }

  return migrationContent
}
