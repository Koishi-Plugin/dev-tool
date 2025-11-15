import { Context, Schema, h, Logger } from 'koishi'
import {} from 'koishi-plugin-adapter-onebot'
import { BackupService } from './backup'
import { DbService } from './dbtool'
import { formatInspect } from './utils'
import { Onebot } from './onebot'
import { Sender } from './sender'
import { ProtobufEncoder } from './protobuf'

export const name = 'dev-tool'
export const inject = ['database']
export const logger = new Logger(name)

export const usage = `
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #4a6ee0;">📌 插件说明</h2>
  <p>📖 <strong>使用文档</strong>：请点击左上角的 <strong>插件主页</strong> 查看插件使用文档</p>
  <p>🔍 <strong>更多插件</strong>：可访问 <a href="https://github.com/YisRime" style="color:#4a6ee0;text-decoration:none;">苡淞的 GitHub</a> 查看本人的所有插件</p>
</div>

<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #e0574a;">❤️ 支持与反馈</h2>
  <p>🌟 喜欢这个插件？请在 <a href="https://github.com/YisRime" style="color:#e0574a;text-decoration:none;">GitHub</a> 上给我一个 Star！</p>
  <p>🐛 遇到问题？请通过 <strong>Issues</strong> 提交反馈，或加入 QQ 群 <a href="https://qm.qq.com/q/PdLMx9Jowq" style="color:#e0574a;text-decoration:none;"><strong>855571375</strong></a> 进行交流</p>
</div>
`

/**
 * 插件配置接口
 */
export interface Config {
  enableOnebot: boolean
  tables: string[]
  autoBackup: boolean
  interval: number
  dir: string
  keepBackups: number
  singleFile: boolean
  logAllEvents: boolean
  logFilterMode: 'whitelist' | 'blacklist'
  logFilters: {
    type: 'user' | 'guild' | 'event'
    content: string
  }[]
}

/**
 * 插件配置Schema定义
 */
export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    enableOnebot: Schema.boolean().description('注册 OneBot 相关工具').default(true),
  }).description('开关配置'),
  Schema.object({
    autoBackup: Schema.boolean().description('启用数据库定时备份').default(false),
    singleFile: Schema.boolean().description('将所有表备份到单个文件').default(false),
    interval: Schema.number().description('自动备份间隔（小时）').default(24).min(1),
    keepBackups: Schema.number().description('保留的备份文件数量（0为不限制）').default(7).min(0),
    dir: Schema.string().description('备份文件存储目录').default('./data/backups'),
    tables: Schema.array(String).description('需要处理的特殊表名（例如包含大写字母的表）'),
  }).description('备份配置'),
  Schema.object({
    logAllEvents: Schema.boolean().description('启用事件捕持').default(false),
    logFilterMode: Schema.union(['whitelist', 'blacklist']).description('过滤模式').default('whitelist'),
    logFilters: Schema.array(Schema.object({
      type: Schema.union(['user', 'guild', 'event' ]).description('过滤类型').role('select'),
      content: Schema.string().description('过滤内容')
    })).role('table').description('过滤列表'),
  }).description('事件配置'),
])

/**
 * 插件主函数
 * @param ctx - Koishi上下文
 * @param config - 插件配置
 */
export function apply(ctx: Context, config: Config) {
  // 实例化服务
  const dbService = new DbService(ctx);
  const backupService = new BackupService(ctx, config);
  ctx.on('dispose', () => backupService.dispose())
  // 初始化数据库命令并注册备份命令
  dbService.initialize();
  backupService.registerBackupCommands(dbService.Command);

  const ins = ctx.command('inspect', '查看详细信息')
    .action(({ session }, target) => {
      if (session.quote) {
        return `平台名：${session.platform}\n` +
               `消息 ID：${session.quote.id}\n` +
               `频道 ID：${session.quote.channel.id}\n` +
               `群组 ID：${session.guildId}\n` +
               `用户 ID：${session.quote.user?.id}\n` +
               `自身 ID：${session.selfId}`;
      }
      if (target) {
        const parsed = h.parse(target);
        if (parsed.length > 0) {
            const { type, attrs } = parsed[0];
            if (type === 'at') {
                return `用户 ID：${attrs.id}`;
            } else if (type === 'sharp') {
                return `频道 ID：${attrs.id}`;
            }
        }
        return '参数无法解析';
      }
      return `平台名：${session.platform}\n` +
             `消息 ID：${session.messageId}\n` +
             `频道 ID：${session.channelId}\n` +
             `群组 ID：${session.guildId}\n` +
             `用户 ID：${session.userId}\n` +
             `自身 ID：${session.selfId}`;
    })

  /**
   * 检查消息元素命令
   */
  ins.subcommand('elements', '检查消息元素')
    .option('id', '-i <messageId:string> 指定消息ID')
    .usage('发送或回复消息以查看其元素结构，使用 -i 指定消息ID')
    .action(async ({ session, options }) => {
      let elements
      const messageId = options.id
      if (messageId) {
        try {
          const message = await session.bot.getMessage(session.channelId, messageId)
          if (!message) return '未找到指定消息'
          elements = message.elements
        } catch (error) {
          return `获取消息失败: ${error.message}`
        }
      } else {
        elements = session.quote ? session.quote.elements : session.elements
      }
      elements = elements.map((element) => {
        if (element.type === 'json') {
          try {
            element.attrs.data = JSON.parse(element.attrs.data)
          } catch (e) {
            logger.warn('解析 JSON 失败:', e)
          }
        }
        return element
      })
      const result = formatInspect(elements, { depth: Infinity })
      return h.text(result)
    })

  /**
   * 获取原始消息内容命令
   */
  ins.subcommand('contents', '获取原始内容')
    .option('id', '-i <messageId:string> 指定消息ID')
    .usage('发送或回复消息以查看其原始内容，使用 -i 指定消息ID')
    .action(async ({ session, options }) => {
      const messageId = options.id;
      if (messageId) {
        try {
          const message = await session.bot.getMessage(session.channelId, messageId);
          if (!message) return '未找到指定消息';
          return h.text(message.content);
        } catch (error) {
          return `获取消息失败: ${error.message}`;
        }
      } else if (session.quote) {
        try {
          const quoteMessage = await session.bot.getMessage(session.channelId, session.quote.id);
          if (!quoteMessage) return '未找到引用消息';
          return h.text(quoteMessage.content);
        } catch (error) {
          return `获取引用消息失败: ${error.message}`;
        }
      } else {
        return h.text(session.event.message.content);
      }
    })

  /**
   * 获取消息ID命令
   */
  ins.subcommand('msgid', '获取消息ID')
    .usage('发送或回复消息以获取其消息ID')
    .action(async ({ session }) => {
      if (session.quote) {
        return `引用消息ID: ${session.quote.id}`;
      } else {
        return `当前消息ID: ${session.messageId}`;
      }
    })

  /**
   * 检查会话信息命令
   */
  ins.subcommand('session', '查看会话信息')
    .usage('查看当前会话的信息')
    .action(async ({ session }) => {
      return h.text(formatInspect(session, { depth: Infinity }));
    })

  // 根据配置决定是否注册 OneBot 相关命令
  if (config.enableOnebot) {
    const onebot = ctx.command('onebot', 'Onebot 工具')
    new Onebot().registerCommands(onebot)
    const encoder = new ProtobufEncoder()
    const Send = new Sender(encoder)
    Send.registerPacketCommands(onebot)
  }

  // 注册事件日志记录器
  if (config.logAllEvents) {
    ctx.on('internal/session', (session) => {
      if (!session.type) return;
      if (!config.logFilters?.length) {
        if (config.logFilterMode === 'blacklist') logger.info(formatInspect(session));
        return;
      }
      const isMatch = config.logFilters.some(rule => {
        if (rule.type === 'user' && session.userId === rule.content) return true;
        if (rule.type === 'guild' && session.guildId === rule.content) return true;
        if (rule.type === 'event' && session.type === rule.content) return true;
        return false;
      });
      const shouldLog = config.logFilterMode === 'whitelist' ? isMatch : !isMatch;
      if (shouldLog) logger.info(formatInspect(session));
    });
  }
}
