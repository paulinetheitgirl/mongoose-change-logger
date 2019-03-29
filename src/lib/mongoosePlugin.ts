import { MongoClient } from 'mongodb';
import { Observable, Subscriber } from 'rxjs';
import { flatMap } from 'rxjs/operators';
import { IChangeEvent, IParams } from '../types/plugin';
import { Schema, Query, Document, Types } from 'mongoose';

const mongooseChangeLogger = (params: IParams) => {
    const {
        connectionString,
        collection = 'changes',
        concurrentSaves = 10,
        modelName,
        mongooseInstance,
    } = params;
    if (!connectionString) throw new Error('Connection string is required');
    if (!modelName) throw new Error('Model name is required');
    if (!mongooseInstance) throw new Error('Mongoose instance is required');

    const mongoClient = new MongoClient(connectionString, { useNewUrlParser: true });
    let dbWriteStream: Subscriber<IChangeEvent>;
    const observable = new Observable<IChangeEvent>((observer) => {
        dbWriteStream = observer;
    });

    observable.pipe(
        flatMap(async (changeEvent: IChangeEvent) => {
                if (!mongoClient.isConnected()) {
                    await mongoClient.connect();
                }
                return mongoClient.db().collection(collection).insertOne(changeEvent);
            }, concurrentSaves),
    ).subscribe(null, (err) => console.error(err));

    const getStack = () => {
        const stack = (new Error().stack || '').split('\n');
        // Filter out the Error and the current by method
        const cleanedStack = stack.slice(3, stack.length - 1);
        return cleanedStack.join('\n');
    };

    const getChangedEvent = (
        id: Types.ObjectId | undefined,
        action: string,
        actor: string,
        stack: string | undefined,
        extraData?: any,
    ) => {
        // const stack = getStack();
        const when = new Date();
        return {
            _id: id,
            modelName,
            stack,
            action,
            when,
            actor,
            ...extraData,
        };
    };

    return (schema: Schema & any) => {
        schema.add({ '__changeId': { type: Schema.Types.ObjectId, select: false }});
        schema.add({ '__actor': { type: Schema.Types.String, select: false }});

        // Query methods
        mongooseInstance.Query.prototype.by = function (actor: string) {
            this.__changeId = new mongooseInstance.Types.ObjectId();
            this.__actor = actor;
            this.__stack = getStack();
            return this;
        };

        const logForQuery = (updateQuery: Query<any>, action: string, set: boolean) => {
            const update = updateQuery.getUpdate();

            if (!updateQuery.__changeId || !updateQuery.__actor) {
                console.warn(`Actor not set for query: ${JSON.stringify(update)}`);
            } else if (set) {
                update.$set.__changeId = updateQuery.__changeId;
                update.$set.__actor = updateQuery.__actor;
                (<any> updateQuery)._update = update;
            }
            dbWriteStream.next(
                getChangedEvent(
                    updateQuery.__changeId,
                    action,
                    updateQuery.__actor,
                    updateQuery.__stack,
                    {
                        update: JSON.stringify(update),
                        conditions: JSON.stringify(updateQuery.getQuery()),
                    },
                ),
            );
        };

        schema.pre('findOneAndUpdate', function (this: Query<any>) {
            logForQuery(this, 'findOneAndUpdate', true);
        });

        schema.pre('deleteMany', function (this: Query<any>) {
            logForQuery(this, 'deleteMany', false);
        });

        schema.pre('deleteOne', function (this: Query<any>) {
            logForQuery(this, 'deleteOne', false);
        });

        schema.pre('findOneAndDelete', function (this: Query<any>) {
            logForQuery(this, 'findOneAndDelete', false);
        });

        schema.pre('findOneAndRemove', function (this: Query<any>) {
            logForQuery(this, 'findOneAndRemove', false);
        });

        schema.pre('remove', function (this: Query<any>) {
            logForQuery(this, 'remove', false);
        });

        schema.pre('update', function (this: Query<any>) {
            logForQuery(this, 'update', true);
        });

        schema.pre('updateOne', function (this: Query<any>) {
            logForQuery(this, 'updateOne', true);
        });

        schema.pre('updateMany', function (this: Query<any>) {
            logForQuery(this, 'updateMany', true);
        });

        // Doc methods
        schema.methods.by = function (actor: any) {
            this.__changeId = new mongooseInstance.Types.ObjectId();
            this.__actor = actor;
            this.__stack = getStack();
            return this;
        };

        const logForDoc = (doc: any, action: string) => {
            if (!doc.__changeId || !doc.__actor) {
                console.warn(`Actor not set for ${action}: ${JSON.stringify(doc)}`);
            }
            const stack = doc.__stack;
            dbWriteStream.next(getChangedEvent(doc.__changeId, action, doc.__actor, stack));
        };

        schema.pre('save', function (this: Document) {
            logForDoc(this, 'save');
            delete this.__stack;
        });

        schema.pre('remove', function (this: Document) {
            logForDoc(this, 'remove');
        });


        // Remove the changeId and actor so that it cant be accessed after the save/remove
        const resetForDoc = (doc: Document) => {
            doc.__changeId = undefined;
            doc.__actor = undefined;
            return doc;
        }
        schema.post('save', function (doc: Document) {
            return resetForDoc(doc);
        });

        schema.post('remove', function (doc: Document) {
            return resetForDoc(doc);
        });
    };
};

export default mongooseChangeLogger;