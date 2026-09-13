import { z } from 'zod';
import { emailSchema } from '../../core/validators';

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(6, 'Password must be at least 6 characters').max(128),
  /** Required only when the same email exists in more than one salon. */
  tenantSlug: z.string().trim().min(1).max(64).optional(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(20),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128)
    .regex(/[a-zA-Z]/, 'Password must contain a letter')
    .regex(/\d/, 'Password must contain a number'),
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
  tenantSlug: z.string().trim().min(1).max(64).optional(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20),
  newPassword: z
    .string()
    .min(8)
    .max(128)
    .regex(/[a-zA-Z]/, 'Password must contain a letter')
    .regex(/\d/, 'Password must contain a number'),
});

export const platformLoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(6).max(128),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
