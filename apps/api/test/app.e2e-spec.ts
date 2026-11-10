import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { ENGINE_GROUP_TABLES } from './../src/engine/engine.tokens.js';
import { TEST_GROUP_TABLES } from './support/testGroupTables.js';

// Boots the full app, so Postgres must be running (pnpm db:up).
describe('ChatController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ENGINE_GROUP_TABLES)
      .useValue(TEST_GROUP_TABLES)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('POST /chat/:agentId returns 404 for an unknown agent', () => {
    return request(app.getHttpServer())
      .post('/chat/no-such-agent')
      .send({ id: 'e2e-thread', messages: [] })
      .expect(404);
  });

  it('POST /chat/:agentId returns 400 without a thread id', () => {
    return request(app.getHttpServer())
      .post('/chat/assistant')
      .send({ messages: [] })
      .expect(400);
  });

  afterEach(async () => {
    await app.close();
  });
});
