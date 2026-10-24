import { Module } from '@nestjs/common';
import { StorageModule } from '../../storage/storage.module.js';
import { SkillUploadStore } from './skill-uploads.js';
import { SkillsController } from './skills.controller.js';
import { SkillsService } from './skills.service.js';

/**
 * Skill uploads and the stored skills (plan 5.1). Needs DatabaseModule (DB),
 * ConfigModule and LoggerModule from the app; imports StorageModule itself.
 */
@Module({
  imports: [StorageModule],
  controllers: [SkillsController],
  providers: [SkillsService, SkillUploadStore],
  exports: [SkillsService],
})
export class SkillsModule {}
