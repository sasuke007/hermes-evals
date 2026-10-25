/** The 404 every experiment route answers for an unknown id. */
import { NotFoundException } from '@nestjs/common';

export const experimentNotFound = (id: string): NotFoundException =>
  new NotFoundException({ statusCode: 404, message: `Experiment ${id} does not exist.` });
