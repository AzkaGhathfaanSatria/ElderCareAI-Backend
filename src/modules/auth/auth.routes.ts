import { Router } from "express";
import {
  login,
  register,
  getMe,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
} from "./auth.controller";
import { authenticate } from "../../common/middleware/auth.middleware";
import { rateLimit } from "../../common/middleware/rateLimit";

// Batas per IP. Bisa diubah lewat env bila terlalu ketat saat pengujian.
const windowMs = Number(process.env.AUTH_RATE_WINDOW_MIN ?? 15) * 60_000;
const loginLimit = rateLimit({ name: "login", max: Number(process.env.AUTH_LOGIN_MAX ?? 10), windowMs });
const accountLimit = rateLimit({ name: "account", max: Number(process.env.AUTH_ACCOUNT_MAX ?? 10), windowMs });

const router = Router();

router.post("/register", accountLimit, register);
router.post("/login", loginLimit, login);
router.get("/me", authenticate, getMe);
router.post("/refresh", refresh);
router.post("/logout", logout);
router.post("/forgot-password", accountLimit, forgotPassword);
router.post("/reset-password", accountLimit, resetPassword);

export default router;