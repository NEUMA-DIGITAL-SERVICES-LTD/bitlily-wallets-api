import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import { ALL_ENTITIES } from './entities';

config();

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/bitlily_crypto',
  entities: ALL_ENTITIES,
  migrations: ['src/migrations/*.ts'],
  synchronize: false,
});
