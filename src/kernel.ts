/// <reference types="siyuan/kernel" />

import type * as kernel from "siyuan/kernel";

class TianGongKernelPlugin {
    private readonly siyuan: kernel.ISiyuan = siyuan;

    constructor() {
        this.siyuan.plugin.lifecycle.onload = this.onload.bind(this);
        this.siyuan.plugin.lifecycle.onloaded = this.onloaded.bind(this);
        this.siyuan.plugin.lifecycle.onrunning = this.onrunning.bind(this);
        this.siyuan.plugin.lifecycle.onunload = this.onunload.bind(this);
    }

    private async onload(): Promise<void> {
        await this.siyuan.logger.info("TianGong AI kernel plugin loaded");
    }

    private async onloaded(): Promise<void> {
        await this.siyuan.logger.info("TianGong AI kernel plugin ready");
    }

    private async onrunning(): Promise<void> {
        await this.siyuan.logger.info("TianGong AI kernel plugin running");
    }

    private async onunload(): Promise<void> {
        await this.siyuan.logger.info("TianGong AI kernel plugin stopped");
    }
}

new TianGongKernelPlugin();

