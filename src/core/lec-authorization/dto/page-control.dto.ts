import { Transform, Type } from 'class-transformer';
import {
  IsDate,
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Max,
  Min,
  MinDate,
  ValidateBy,
  ValidateIf,
} from 'class-validator';

export class PageControlDto {
  @IsUUID()
  pageId: string;

  @IsUUID()
  operationId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER - 1)
  expectedVersion: number;
}

export class ClassifyPageDto extends PageControlDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  classification: number;
}

export class TransferPageOwnerDto extends PageControlDto {
  @IsUUID()
  ownerUserId: string;
}

export class RevokePageGrantDto extends PageControlDto {
  @IsUUID()
  grantId: string;
}

export class RequestPageAccessDto {
  @IsString()
  @IsNotEmpty()
  pageId: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @ValidateBy({
    name: 'maxUnicodeLength',
    validator: { validate: (value) => [...String(value)].length <= 1000 },
  })
  reason: string;
}

export class ReviewPageAccessDto extends PageControlDto {
  @IsUUID()
  accessRequestId: string;

  @IsIn(['APPROVE', 'REJECT'])
  decision: 'APPROVE' | 'REJECT';

  @ValidateIf((dto: ReviewPageAccessDto) => dto.decision === 'APPROVE')
  @IsDefined()
  @Type(() => Date)
  @IsDate()
  @MinDate(() => new Date())
  expiresAt?: Date;
}

export class RevokePageAccessDto extends PageControlDto {
  @IsUUID()
  accessRequestId: string;
}
