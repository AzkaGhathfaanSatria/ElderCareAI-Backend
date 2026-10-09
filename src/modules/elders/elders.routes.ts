
import { Router } from "express";
import { authenticate } from "../../common/middleware/auth.middleware";
import { listElders } from "./elders.controller";

const router = Router();

router.get("/", authenticate, listElders);

export default router;