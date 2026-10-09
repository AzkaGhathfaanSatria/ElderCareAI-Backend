import { Router } from "express";
import {
  login,
  register,
  getMe,
  refresh,
  logout,
} from "./auth.controller";
import { authenticate } from "../../common/middleware/auth.middleware";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.get("/me", authenticate, getMe);
router.post("/refresh", refresh);
router.post("/logout", logout);

export default router;