import { ErrorRequestHandler } from "express";

import axios from "axios";

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (axios.isAxiosError(error)) {
    // Log only safe fields. A full AxiosError embeds the outgoing request
    // headers — including the Fireblocks X-API-Key and bearer token — so we
    // must never log the whole object.
    const data = (error.response?.data ?? {}) as {
      message?: string;
      code?: number;
    };
    console.error(
      `error handling request: ${error.config?.method?.toUpperCase() ?? ""} ${
        error.config?.url ?? ""
      } -> ${error.response?.status ?? "?"} ${data.message ?? error.message}`,
    );

    if (res.headersSent) {
      return next(error);
    }

    res.status(error.response?.status ?? 500).json({
      error: error.message,
      message: data.message,
      code: data.code ?? -1,
    });
  } else {
    console.error("error handling request:", error?.message ?? error);

    if (res.headersSent) {
      return next(error);
    }

    res
      .status(error.statusCode ?? error.status ?? 500)
      .json({ error: error.message ?? "Internal server error" });
  }
};
