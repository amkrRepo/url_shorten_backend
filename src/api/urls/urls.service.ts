import { BadRequestException, Injectable, Post } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import type { UrlDetailsDto } from './dto/urls.dto';
import crypto from 'crypto';

@Injectable()
export class UrlsService {
  constructor(private readonly dbService: DbService) {}

  async getUrlDetails(short_code: string) {
    try {
      const urlDetails = await this.dbService.urls.findUnique({
        where: { short_code },
      });

      if (!urlDetails) {
        throw new BadRequestException('URL not found');
      }

      return urlDetails;
    } catch {
      throw new BadRequestException('URL not found');
    }
  }

  async createShortUrl(urlDetails: UrlDetailsDto) {
    try {
      const { original_url } = urlDetails;

      if (!original_url) {
        throw new BadRequestException('Original URL is required');
      }

      const code = crypto.randomBytes(4).toString('hex');

      const newUrl = await this.dbService.urls.create({
        data: { original_url, short_code: code },
      });

      return newUrl;
    } catch (error) {
      throw error;
    }
  }
}
