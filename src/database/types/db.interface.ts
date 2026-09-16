import { DB } from '@docmost/db/types/db';
import { PageEmbeddings } from '@docmost/db/types/embeddings.types';
import { DB as LecDB } from './lec-db';

export interface DbInterface extends DB, LecDB {
  pageEmbeddings: PageEmbeddings;
}
