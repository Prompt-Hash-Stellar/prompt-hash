import express from "express";
import { CreateUser, GetUsers, GetPayoutSettings, UpdatePayoutSettings } from "../controllers/controllers";

export const userRouter = express.Router();

userRouter.route("/").post(CreateUser);

userRouter.route("/").get(GetUsers);

userRouter.route("/:walletAddress/payout-settings").get(GetPayoutSettings).post(UpdatePayoutSettings);
