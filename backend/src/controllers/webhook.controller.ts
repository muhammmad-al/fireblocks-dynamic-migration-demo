import { NextFunction, Request, Response } from "express";
import { Clients } from "../interfaces/Clients";
import { ITransactionCreatedMessagePayload } from "../interfaces/transaction";
import { patchTransactionAmountUsd } from "../util/cmc/patchTransactionAmountUsd";
import {
  handleNcwDeviceMessage,
  handleTransactionCreated,
  handleTransactionStatusUpdated,
  handleWalletEventMessage,
} from "../services/webhook.service";

export class WebhookController {
  constructor(private readonly clients: Clients) {}

  async handle(req: Request, res: Response, next: NextFunction) {
    try {
      // Map Fireblocks V2 webhook eventType to legacy V1 type strings the rest of this handler expects.
      const v2ToV1: Record<string, string> = {
        "transaction.created": "TRANSACTION_CREATED",
        "transaction.status.updated": "TRANSACTION_STATUS_UPDATED",
        "transaction.approval_status.updated": "TRANSACTION_APPROVAL_STATUS_UPDATED",
        "embedded_wallet.asset.balance_updated": "END_USER_WALLET_BALANCE_UPDATE",
        "embedded_wallet.device.message": "NCW_DEVICE_MESSAGE",
        "embedded_wallet.transaction.signing": "NCW_DEVICE_MESSAGE",
        "ncw.device.message": "NCW_DEVICE_MESSAGE",
      };
      const type =
        req.body.type ?? v2ToV1[req.body.eventType] ?? req.body.eventType;
      const timestamp = req.body.timestamp ?? req.body.createdAt;
      console.log(
        `received webhook, type: ${type} timestamp: ${timestamp} body: ${JSON.stringify(
          req.body,
        )} `,
      );

      switch (type) {
        case "NCW_DEVICE_MESSAGE": {
          const { walletId, deviceId, physicalDeviceId, data } = req.body;
          await handleNcwDeviceMessage(
            deviceId,
            walletId,
            physicalDeviceId,
            data,
          );
          return res.status(200).send("ok");
        }

        case "TRANSACTION_CREATED": {
          const { data } = req.body as ITransactionCreatedMessagePayload;
          const { id, status } = data;
          await patchTransactionAmountUsd(data, this.clients.cmc);
          await handleTransactionCreated(id, status, data);
          return res.status(200).send("ok");
        }

        case "TRANSACTION_STATUS_UPDATED": {
          const { data } = req.body as ITransactionCreatedMessagePayload;
          const { id, status } = data;
          await patchTransactionAmountUsd(data, this.clients.cmc);
          await handleTransactionStatusUpdated(id, status, data);
          return res.status(200).send("ok");
        }

        case "NCW_CREATED":
        case "NCW_ACCOUNT_CREATED":
        case "NCW_ASSET_CREATED":
        case "NCW_STATUS_UPDATED":
        case "NCW_ADD_DEVICE_SETUP_REQUESTED": {
          await handleWalletEventMessage(type, req.body);
          return res.status(200).send("ok");
        }

        case "ON_NEW_EXTERNAL_TRANSACTION":
        case "VAULT_ACCOUNT_ADDED":
        case "VAULT_WALLET_READY":
        case "UNMANAGED_WALLET_ADDED":
        case "UNMANAGED_WALLET_REMOVED":
        case "THIRD_PARTY_ACCOUNT_ADDED":
        case "NETWORK_CONNECTION_ADDED":
        case "NETWORK_CONNECTION_REMOVED":
        case "CONFIG_CHANGE_REQUEST_STATUS":
        case "TRANSACTION_APPROVAL_STATUS_UPDATED":
        case "VAULT_ACCOUNT_ASSET_ADDED":
        case "EXTERNAL_WALLET_ASSET_ADDED":
        case "INTERNAL_WALLET_ASSET_ADDED":
        case "NCW_TRANSACTION_STATUS_UPDATED":
        case "END_USER_WALLET_BALANCE_UPDATE":
          return res.status(200).send("ok");

        default:
          console.error(`unknown webhook type ${type}`);
          return res.status(400).send("error");
      }
    } catch (err) {
      return next(err);
    }
  }
}
