import type { ClientSession } from 'mongodb';
import { ObjectId } from 'bson';
import {
  type Configuration,
  type CountOptions,
  DatabaseDriver,
  type Dictionary,
  type EntityData,
  type EntityDictionary,
  type EntityField,
  type EntityKey,
  type EntityManager,
  EntityManagerType,
  type FilterQuery,
  type FindByCursorOptions,
  type FindOneOptions,
  type FindOptions,
  type IDatabaseDriver,
  type NativeInsertUpdateManyOptions,
  type NativeInsertUpdateOptions,
  type PopulateOptions,
  type QueryResult,
  ReferenceKind,
  type Transaction,
  type UpsertManyOptions,
  type UpsertOptions,
  Utils,
} from '@mikro-orm/core';
import { MongoConnection } from './MongoConnection';
import { MongoPlatform } from './MongoPlatform';
import { MongoEntityManager } from './MongoEntityManager';

export class MongoDriver extends DatabaseDriver<MongoConnection> {

  [EntityManagerType]!: MongoEntityManager<this>;

  protected override readonly connection = new MongoConnection(this.config);
  protected override readonly platform = new MongoPlatform();

  constructor(config: Configuration) {
    super(config, ['mongodb']);
  }

  override createEntityManager<D extends IDatabaseDriver = IDatabaseDriver>(useContext?: boolean): D[typeof EntityManagerType] {
    return new MongoEntityManager(this.config, this, this.metadata, useContext) as unknown as EntityManager<D>;
  }

  async find<T extends object, P extends string = never, F extends string = '*'>(entityName: string, where: FilterQuery<T>, options: FindOptions<T, P, F> = {}): Promise<EntityData<T>[]> {
    if (this.metadata.find(entityName)?.virtual) {
      return this.findVirtual(entityName, where, options);
    }

    const { first, last, before, after } = options as FindByCursorOptions<T>;
    const fields = this.buildFields(entityName, options.populate as unknown as PopulateOptions<T>[] || [], options.fields);
    where = this.renameFields(entityName, where, true);
    const isCursorPagination = [first, last, before, after].some(v => v != null);

    if (isCursorPagination) {
      const andWhere = (cond1: FilterQuery<T>, cond2: FilterQuery<T>): FilterQuery<T> => {
        if (Utils.isEmpty(cond1)) {
          return cond2;
        }

        if (Utils.isEmpty(cond2)) {
          return cond1;
        }

        return { $and: [cond1, cond2] } as FilterQuery<T>;
      };
      const meta = this.metadata.find<T>(entityName)!;
      const { orderBy: newOrderBy, where: newWhere } = this.processCursorOptions(meta, options, options.orderBy!);
      const newWhereConverted = this.renameFields(entityName, newWhere as FilterQuery<T>, true);
      const orderBy = Utils.asArray(newOrderBy).map(order => this.renameFields(entityName, order));
      const res = await this.rethrow(this.getConnection('read').find(entityName, andWhere(where, newWhereConverted), orderBy, options.limit, options.offset, fields, options.ctx));

      if (isCursorPagination && !first && !!last) {
        res.reverse();
      }

      return res.map(r => this.mapResult<T>(r, this.metadata.find<T>(entityName))!);
    }

    const orderBy = Utils.asArray(options.orderBy).map(orderBy =>
      this.renameFields(entityName, orderBy, false),
    );
    const res = await this.rethrow(this.getConnection('read').find(entityName, where, orderBy, options.limit, options.offset, fields, options.ctx));

    return res.map(r => this.mapResult<T>(r, this.metadata.find<T>(entityName))!);
  }

  async findOne<T extends object, P extends string = never, F extends string = '*'>(entityName: string, where: FilterQuery<T>, options: FindOneOptions<T, P, F> = { populate: [], orderBy: {} }): Promise<EntityData<T> | null> {
    if (this.metadata.find(entityName)?.virtual) {
      const [item] = await this.findVirtual(entityName, where, options as FindOptions<T, any, any>);
      /* istanbul ignore next */
      return item ?? null;
    }

    if (Utils.isPrimaryKey(where)) {
      where = this.buildFilterById(entityName, where as string);
    }

    const fields = this.buildFields(entityName, options.populate as unknown as PopulateOptions<T>[] || [], options.fields);
    where = this.renameFields(entityName, where, true);
    const orderBy = Utils.asArray(options.orderBy).map(orderBy =>
      this.renameFields(entityName, orderBy, false),
    );
    const res = await this.rethrow(this.getConnection('read').find(entityName, where, orderBy, 1, undefined, fields, options.ctx));

    return this.mapResult<T>(res[0], this.metadata.find(entityName)!);
  }

  override async findVirtual<T extends object>(entityName: string, where: FilterQuery<T>, options: FindOptions<T, any, any>): Promise<EntityData<T>[]> {
    const meta = this.metadata.find(entityName)!;

    if (meta.expression instanceof Function) {
      const em = this.createEntityManager<MongoDriver>();
      return meta.expression(em, where, options) as EntityData<T>[];
    }

    /* istanbul ignore next */
    return super.findVirtual(entityName, where, options);
  }

  async count<T extends object>(entityName: string, where: FilterQuery<T>, options: CountOptions<T> = {}, ctx?: Transaction<ClientSession>): Promise<number> {
    /* istanbul ignore next */
    if (this.metadata.find(entityName)?.virtual) {
      return this.countVirtual(entityName, where, options);
    }

    where = this.renameFields(entityName, where, true);
    return this.rethrow(this.getConnection('read').countDocuments(entityName, where as object, ctx));
  }

  async nativeInsert<T extends object>(entityName: string, data: EntityDictionary<T>, options: NativeInsertUpdateOptions<T> = {}): Promise<QueryResult<T>> {
    data = this.renameFields(entityName, data);
    return this.rethrow(this.getConnection('write').insertOne(entityName, data, options.ctx)) as unknown as Promise<QueryResult<T>>;
  }

  async nativeInsertMany<T extends object>(entityName: string, data: EntityDictionary<T>[], options: NativeInsertUpdateManyOptions<T> = {}): Promise<QueryResult<T>> {
    data = data.map(d => this.renameFields(entityName, d));
    const meta = this.metadata.find(entityName);
    /* istanbul ignore next */
    const pk = meta?.getPrimaryProps()[0].fieldNames[0] ?? '_id';
    const res = await this.rethrow(this.getConnection('write').insertMany(entityName, data as any[], options.ctx));
    res.rows = res.insertedIds!.map(id => ({ [pk]: id }));

    return res as unknown as QueryResult<T>;
  }

  async nativeUpdate<T extends object>(entityName: string, where: FilterQuery<T>, data: EntityDictionary<T>, options: NativeInsertUpdateOptions<T> & UpsertOptions<T> = {}): Promise<QueryResult<T>> {
    if (Utils.isPrimaryKey(where)) {
      where = this.buildFilterById(entityName, where as string);
    }

    where = this.renameFields(entityName, where, true);
    data = this.renameFields(entityName, data);
    options = { ...options };

    const meta = this.metadata.find(entityName);
    /* istanbul ignore next */
    const rename = (field: keyof T) => meta ? (meta.properties[field as string]?.fieldNames[0] as keyof T ?? field) : field;

    if (options.onConflictFields) {
      options.onConflictFields = options.onConflictFields.map(rename);
    }

    if (options.onConflictMergeFields) {
      options.onConflictMergeFields = options.onConflictMergeFields.map(rename);
    }

    if (options.onConflictExcludeFields) {
      options.onConflictExcludeFields = options.onConflictExcludeFields.map(rename);
    }

    return this.rethrow(this.getConnection('write').updateMany<T>(entityName, where as object, data as object, options.ctx, options.upsert, options));
  }

  override async nativeUpdateMany<T extends object>(entityName: string, where: FilterQuery<T>[], data: EntityDictionary<T>[], options: NativeInsertUpdateOptions<T> & UpsertManyOptions<T> = {}): Promise<QueryResult<T>> {
    where = where.map(row => {
      if (Utils.isPlainObject(row)) {
        return this.renameFields(entityName, row, true);
      }

      return row;
    });
    data = data.map(row => this.renameFields(entityName, row));
    options = { ...options };

    const meta = this.metadata.find(entityName);
    /* istanbul ignore next */
    const rename = (field: keyof T) => meta ? (meta.properties[field as string]?.fieldNames[0] as keyof T ?? field) : field;

    if (options.onConflictFields) {
      options.onConflictFields = options.onConflictFields.map(rename);
    }

    if (options.onConflictMergeFields) {
      options.onConflictMergeFields = options.onConflictMergeFields.map(rename);
    }

    if (options.onConflictExcludeFields) {
      options.onConflictExcludeFields = options.onConflictExcludeFields.map(rename);
    }

    return this.rethrow(this.getConnection('write').bulkUpdateMany<T>(entityName, where as object[], data as object[], options.ctx, options.upsert, options));
  }

  async nativeDelete<T extends object>(entityName: string, where: FilterQuery<T>, options: { ctx?: Transaction<ClientSession> } = {}): Promise<QueryResult<T>> {
    if (Utils.isPrimaryKey(where)) {
      where = this.buildFilterById(entityName, where as string);
    }

    where = this.renameFields(entityName, where, true);

    return this.rethrow(this.getConnection('write').deleteMany(entityName, where as object, options.ctx)) as unknown as Promise<QueryResult<T>>;
  }

  override async aggregate(entityName: string, pipeline: any[], ctx?: Transaction<ClientSession>): Promise<any[]> {
    return this.rethrow(this.getConnection('read').aggregate(entityName, pipeline, ctx));
  }

  override getPlatform(): MongoPlatform {
    return this.platform;
  }

  private renameFields<T extends object>(entityName: string, data: T, where = false, object?: boolean): T {
    // copy to new variable to prevent changing the T type or doing as unknown casts
    const copiedData: Dictionary = Object.assign({}, data); // copy first
    const meta = this.metadata.find(entityName);

    if (meta?.serializedPrimaryKey && !meta.embeddable && meta.serializedPrimaryKey !== meta.primaryKeys[0]) {
      Utils.renameKey(copiedData, meta.serializedPrimaryKey, meta.primaryKeys[0]);
    }

    if (meta && !meta.embeddable) {
      this.inlineEmbeddables(meta, copiedData, where);
    }

    // If we had a query with $fulltext and some filter we end up with $and with $fulltext in it.
    // We will try to move $fulltext to top level.
    if (copiedData.$and) {
      for (let i = 0; i < copiedData.$and.length; i++) {
        const and = copiedData.$and[i];
        if ('$fulltext' in and) {
          /* istanbul ignore next */
          if ('$fulltext' in copiedData) {
            throw new Error('Cannot merge multiple $fulltext conditions to top level of the query object.');
          }

          copiedData.$fulltext = and.$fulltext!;
          delete and.$fulltext;
        }
      }
    }

    // move search terms from data['$fulltext'] to mongo's structure: data['$text']['search']
    if ('$fulltext' in copiedData) {
      copiedData.$text = { $search: copiedData.$fulltext! };
      delete copiedData.$fulltext;
    }

    // mongo only allows the $text operator in the root of the object and will
    // search all documents where the field has a text index.
    if (Utils.hasNestedKey(copiedData, '$fulltext')) {
      throw new Error('Full text search is only supported on the top level of the query object.');
    }

    Utils.keys(copiedData).forEach(k => {
      if (Utils.isGroupOperator(k)) {
        /* istanbul ignore else */
        if (Array.isArray(copiedData[k])) {
          copiedData[k] = (copiedData[k] as any[]).map(v => this.renameFields(entityName, v));
        } else {
          copiedData[k] = this.renameFields(entityName, copiedData[k]);
        }

        return;
      }

      if (meta?.properties[k as EntityKey<T>]) {
        const prop = meta.properties[k];
        let isObjectId = false;

        if (prop.kind === ReferenceKind.SCALAR) {
          isObjectId = prop.type.toLowerCase() === 'objectid';
        } else if (prop.kind === ReferenceKind.EMBEDDED) {
          if (copiedData[prop.name] == null) {
            return;
          }

          if (prop.array && Array.isArray(copiedData[prop.name])) {
            copiedData[prop.name] = copiedData[prop.name].map((item: Dictionary) => this.renameFields(prop.type, item, where, true));
          } else {
            copiedData[prop.name] = this.renameFields(prop.type, copiedData[prop.name], where, prop.object || object);
          }
        } else {
          const meta2 = this.metadata.find(prop.type)!;
          const pk = meta2.properties[meta2.primaryKeys[0]];
          isObjectId = pk.type.toLowerCase() === 'objectid';
        }

        if (isObjectId) {
          copiedData[k] = this.convertObjectIds(copiedData[k]);
        }

        if (prop.fieldNames) {
          Utils.renameKey(copiedData, k, prop.fieldNames[0]);
        }
      }

      if (Utils.isPlainObject(copiedData[k]) && '$re' in copiedData[k]) {
        copiedData[k] = new RegExp(copiedData[k].$re);
      }
    });

    return copiedData as T;
  }

  private convertObjectIds<T extends ObjectId | Dictionary | any[]>(data: T): T {
    if (data instanceof ObjectId) {
      return data;
    }

    if (Utils.isString(data) && data.match(/^[0-9a-f]{24}$/i)) {
      return new ObjectId(data) as T;
    }

    if (Array.isArray(data)) {
      return (data as T[]).map((item: any) => this.convertObjectIds(item)) as T;
    }

    if (Utils.isObject(data)) {
      Object.keys(data).forEach(k => {
        data[k] = this.convertObjectIds(data[k]);
      });
    }

    return data;
  }

  private buildFilterById<T extends { _id: any }>(entityName: string, id: string): FilterQuery<T> {
    const meta = this.metadata.find(entityName)!;

    if (meta.properties[meta.primaryKeys[0]].type.toLowerCase() === 'objectid') {
      return { _id: new ObjectId(id) } as FilterQuery<T>;
    }

    return { _id: id } as FilterQuery<T>;
  }

  protected buildFields<T extends object, P extends string = never>(entityName: string, populate: PopulateOptions<T>[], fields?: readonly EntityField<T, P>[]): string[] | undefined {
    const meta = this.metadata.find<T>(entityName);

    if (!meta) {
      return fields as string[];
    }

    const lazyProps = meta.props.filter(prop => prop.lazy && !populate.some(p => p.field === prop.name || p.all));
    const ret: string[] = [];

    if (fields) {
      for (let field of fields) {
        /* istanbul ignore next */
        if (Utils.isPlainObject(field)) {
          continue;
        }

        if (field.toString().includes('.')) {
          field = field.toString().substring(0, field.toString().indexOf('.')) as EntityField<T, P>;
        }

        let prop = meta.properties[field as EntityKey<T>];

        /* istanbul ignore else */
        if (prop) {
          if (!prop.fieldNames) {
            continue;
          }

          prop = prop.serializedPrimaryKey ? meta.getPrimaryProps()[0] : prop;
          ret.push(prop.fieldNames[0]);
        } else if (field === '*') {
          const props = meta.props.filter(prop => this.platform.shouldHaveColumn(prop, populate));
          ret.push(...Utils.flatten(props.filter(p => !lazyProps.includes(p)).map(p => p.fieldNames)));
        } else {
          ret.push(field as keyof T & string);
        }
      }

      ret.unshift(...meta.primaryKeys.filter(pk => !fields.includes(pk)));
    } else if (lazyProps.filter(p => !p.formula).length > 0) {
      const props = meta.props.filter(prop => this.platform.shouldHaveColumn(prop, populate));
      ret.push(...Utils.flatten(props.filter(p => !lazyProps.includes(p)).map(p => p.fieldNames)));
    }

    return ret.length > 0 ? ret : undefined;
  }

}
