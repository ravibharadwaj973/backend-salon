import { z } from 'zod';
import { emailSchema, idSchema, phoneSchema, searchQuery } from '../../core/validators';

export const roleSchema = z.enum([
  'OWNER',
  'ADMIN',
  'REGIONAL_MANAGER',
  'MANAGER',
  'RECEPTIONIST',
  'STYLIST',
  'ACCOUNTANT',
]);

export const createUserSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: emailSchema,
  phone: phoneSchema.optional(),
  password: z.string().min(8).max(128),
  role: roleSchema,
  branchIds: z.array(idSchema).default([]),
  mustChangePassword: z.boolean().default(true),
  /** Create a matching staff profile so the user can be booked. */
  createStaffProfile: z.boolean().default(false),
  staffBranchId: idSchema.optional(),
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: phoneSchema.optional(),
  role: roleSchema.optional(),
  isActive: z.boolean().optional(),
  avatarUrl: z.string().url().max(500).optional(),
  branchIds: z.array(idSchema).optional(),
});

export const resetUserPasswordSchema = z.object({
  newPassword: z.string().min(8).max(128),
  mustChangePassword: z.boolean().default(true),
});

export const listUsersQuery = searchQuery.extend({
  role: roleSchema.optional(),
  isActive: z.enum(['true', 'false']).optional(),
  branchId: idSchema.optional(),
});

export const permissionOverrideSchema = z.object({
  permission: z.string().trim().min(3).max(60),
  allow: z.boolean(),
});
