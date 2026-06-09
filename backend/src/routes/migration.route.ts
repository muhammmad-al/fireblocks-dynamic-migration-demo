// FOR SECURITY RESEARCH ONLY — NOT FOR PRODUCTION USE
import { Router } from "express";
import { MigrationController } from "../controllers/migration.controller";
import { MigrationService } from "../services/migration.service";

export function createMigrationRoute() {
  const service = new MigrationService();
  const controller = new MigrationController(service);
  const route = Router({ mergeParams: true });

  route.post("/start", controller.start.bind(controller));
  route.post("/complete", controller.complete.bind(controller));

  return route;
}
