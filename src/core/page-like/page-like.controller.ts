import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsUUID } from 'class-validator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageAccessService } from '../page/page-access/page-access.service';
import { PageLikeService } from './page-like.service';

class PageLikeDto {
  @IsUUID()
  pageId: string;
}

@UseGuards(JwtAuthGuard)
@Controller('pages')
export class PageLikeController {
  constructor(
    private readonly pageLikeService: PageLikeService,
    private readonly pageRepo: PageRepo,
    private readonly pageAccess: PageAccessService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('like')
  async like(@Body() dto: PageLikeDto, @AuthUser() user: User) {
    const page = await this.getPage(dto.pageId, user);
    return this.pageLikeService.like(user, page);
  }

  @HttpCode(HttpStatus.OK)
  @Post('unlike')
  async unlike(@Body() dto: PageLikeDto, @AuthUser() user: User) {
    const page = await this.getPage(dto.pageId, user);
    return this.pageLikeService.unlike(user.id, page.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('like-status')
  async status(@Body() dto: PageLikeDto, @AuthUser() user: User) {
    const page = await this.getPage(dto.pageId, user);
    return this.pageLikeService.status(user.id, page.id);
  }

  private async getPage(pageId: string, user: User) {
    const page = await this.pageRepo.findById(pageId);
    if (!page) throw new NotFoundException('Page not found');
    await this.pageAccess.validateCanView(page, user);
    return page;
  }
}
