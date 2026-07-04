import express from "express";
import { TestPromptProxy } from "../controllers/controllers";

export const chatRouter = express.Router();

chatRouter.route("/").post(TestPromptProxy);
