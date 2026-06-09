// Proof of concept — demonstrates the migration audit model; not production-hardened.
import { Request, Response, NextFunction } from "express";
import { MigrationService } from "../services/migration.service";

export class MigrationController {
  constructor(private readonly service: MigrationService) {}

  async start(req: Request, res: Response, next: NextFunction) {
    try {
      const { sub } = req.auth!.payload;
      const { walletId, assetId } = req.body ?? {};
      if (typeof walletId !== "string" || typeof assetId !== "string") {
        res.status(400).json({ error: "walletId and assetId required" });
        return;
      }
      const record = this.service.start(sub!, walletId, assetId);
      res.setHeader("Cache-Control", "no-store");
      res.json(record);
    } catch (err) {
      next(err);
    }
  }

  async complete(req: Request, res: Response, next: NextFunction) {
    try {
      const { sub } = req.auth!.payload;
      const { migrationId, fireblocksAddress, dynamicAddress } = req.body ?? {};
      if (
        typeof migrationId !== "string" ||
        typeof fireblocksAddress !== "string" ||
        typeof dynamicAddress !== "string"
      ) {
        res
          .status(400)
          .json({
            error: "migrationId, fireblocksAddress, dynamicAddress required",
          });
        return;
      }
      if (
        Object.prototype.hasOwnProperty.call(req.body ?? {}, "privateKey") ||
        Object.prototype.hasOwnProperty.call(req.body ?? {}, "key")
      ) {
        res
          .status(400)
          .json({ error: "private key material must not be sent to this endpoint" });
        return;
      }
      const record = this.service.complete(
        sub!,
        migrationId,
        fireblocksAddress,
        dynamicAddress,
      );
      res.setHeader("Cache-Control", "no-store");
      res.json(record);
    } catch (err) {
      next(err);
    }
  }
}
