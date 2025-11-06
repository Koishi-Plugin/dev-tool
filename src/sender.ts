import { Session, Command, h } from 'koishi'
import { ProtobufEncoder } from './protobuf'
import { promisify } from 'util'
import { gzip as _gzip, gunzip as _gunzip } from 'zlib'
import { logger } from './index'

const gzip = promisify(_gzip)
const gunzip = promisify(_gunzip)

/**
 * JSON替换器，处理特殊类型数据
 * @param key - 对象键名
 * @param value - 对象值
 * @returns 处理后的值
 */
function jsonReplacer(key: string, value: any): any {
  if (typeof value === 'bigint') {
    return Number(value) >= Number.MAX_SAFE_INTEGER ? value.toString() : Number(value)
  } else if (Buffer.isBuffer(value)) {
    return `hex->${value.toString('hex')}`
  } else if (value?.type === 'Buffer' && Array.isArray(value.data)) {
    return `hex->${Buffer.from(value.data).toString('hex')}`
  }
  return value
}

/**
 * 消息发送器类
 */
export class Sender {
  constructor(private encoder: ProtobufEncoder) {}

  /**
   * 检查字符串是否为有效的十六进制字符串
   * @param s - 待检查的字符串
   * @returns 是否为有效的十六进制字符串
   */
  private isHexString(s: string): boolean {
    return s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s)
  }

  /**
   * 处理 JSON 数据并将十六进制字符串转换为缓冲区
   * @param data - 待处理的数据
   * @param path - 当前路径
   * @returns 处理后的数据
   */
  private processJson(data: any, path: string[] = []): any {
    if (typeof data === 'string') {
      if (path.length >= 2 && path.slice(-2).join(',') === '5,2' && this.isHexString(data))
        return Buffer.from(data, 'hex')
      if (data.startsWith('hex->') && this.isHexString(data.slice(5)))
        return Buffer.from(data.slice(5), 'hex')
      return data
    }
    if (Array.isArray(data)) return data.map((item, i) => this.processJson(item, [...path, (i + 1).toString()]))
    if (typeof data === 'object' && data !== null) {
      const result: any = {}
      for (const [key, value] of Object.entries(data)) result[parseInt(key)] = this.processJson(value, [...path, key])
      return result
    }
    return data
  }

  /**
   * 发送数据包
   * @param session - 会话对象
   * @param cmd - 命令名称
   * @param packet - 数据包内容
   * @returns 响应结果
   */
  private async sendPacket(session: Session, cmd: string, packet: any): Promise<any> {
    const encodedData = this.encoder.encode(this.processJson(packet))
    const hexString = Buffer.from(encodedData).toString('hex')
    const resp = await session.onebot._request('send_packet', { cmd, data: hexString })
    return resp
  }

  /**
   * 获取消息数据
   * @param session - 会话对象
   * @param messageId - 消息ID或序列号
   * @param isSeq - 是否为序列号模式
   * @returns 消息数据或null
   */
  private async getMessage(session: Session, messageId: string, isSeq: boolean = false): Promise<any> {
    let seq: number
    if (isSeq) {
      seq = parseInt(messageId)
    } else {
      const msgInfo = await session.onebot._request('get_msg', { message_id: messageId })
      const seqValue = msgInfo?.data?.real_seq || msgInfo?.data?.seq
      if (!seqValue) throw new Error('无法获取 Seq')
      seq = typeof seqValue === 'string' ? parseInt(seqValue) : seqValue
    }
    const isGroup = !!session.guildId
    const packet = {
      "1": {
        "1": parseInt(isGroup ? session.guildId : session.userId || '0'),
        "2": seq,
        "3": seq
      },
      "2": true
    }
    const cmd = isGroup
      ? 'trpc.msg.register_proxy.RegisterProxy.SsoGetGroupMsg'
      : 'trpc.msg.register_proxy.RegisterProxy.SsoGetC2CMsg'
    const encodedData = this.encoder.encode(packet)
    const hexString = Buffer.from(encodedData).toString('hex')
    const resp = await session.onebot._request('send_packet', { cmd, data: hexString })
    try {
      return resp?.data ? this.encoder.decode(resp.data) : null
    } catch (e) {
      logger.warn(`Failed to decode getMessage response for seq ${seq}: ${e.message}`)
      return null
    }
  }

  /**
   * 直接发送 protobuf 元素数据
   * @param session - 会话对象
   * @param elementsData - 元素数据数组
   */
  async sendProtobufElements(session: Session, elementsData: any[]): Promise<void> {
    const packet = {
      1: { [session.guildId ? '2' : '1']: { 1: parseInt(session.guildId || session.userId || '0') } },
      2: { 1: 1, 2: 0, 3: 0 },
      3: { 1: { 2: elementsData } },
      4: Math.floor(Math.random() * 0xFFFFFFFF),
      5: Math.floor(Math.random() * 0xFFFFFFFF)
    }
    await this.sendPacket(session, 'MessageSvc.PbSendMsg', packet)
  }

  /**
   * 发送长消息并返回resid
   * @param session - 会话对象
   * @param content - 消息内容
   * @returns 长消息ID
   */
  async sendLong(session: Session, content: any): Promise<string> {
    const data = {
      "2": {
        "1": "MultiMsg",
        "2": { "1": [{ "3": { "1": { "2": typeof content === 'object' ? content : JSON.parse(content) } } }] }
      }
    }
    const encodedData = this.encoder.encode(this.processJson(data))
    const compressedData = await gzip(encodedData)
    const target = BigInt(session.guildId || session.userId)
    const packet = {
      "2": {
        "1": session.guildId ? 3 : 1,
        "2": { "2": target },
        "3": target.toString(),
        "4": compressedData
      },
      "15": { "1": 4, "2": 2, "3": 9, "4": 0 }
    }
    const resp = await this.sendPacket(session, 'trpc.group.long_msg_interface.MsgService.SsoSendLongMsg', packet)
    return resp?.["2"]?.["3"] || ''
  }

  /**
   * 发送长消息元素
   * @param session - 会话对象
   * @param content - 消息内容
   */
  async sendLongElement(session: Session, content: any): Promise<void> {
    const resid = await this.sendLong(session, content)
    if (resid) {
      const elem = {
        "37": {
          "6": 1,
          "7": resid,
          "17": 0,
          "19": { "15": 0, "31": 0, "41": 0 }
        }
      }
      await this.sendProtobufElements(session, [elem])
    }
  }

  /**
   * 接收长消息
   * @param session - 会话对象
   * @param resid - 长消息ID
   * @returns 消息数据或null
   */
  async receiveLong(session: Session, resid: string): Promise<any> {
    const packet = {
      "1": { "2": resid, "3": true },
      "15": { "1": 2, "2": 0, "3": 0, "4": 0 }
    }
    const resp = await this.sendPacket(session, 'trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg', packet)
    try {
      if (resp?.data) {
        const decodedResp = this.encoder.decode(resp.data)
        const compressedData = decodedResp?.["1"]?.["4"]
        if (compressedData) {
          const decompressedData = await gunzip(compressedData)
          return this.encoder.decode(decompressedData)
        }
      }
    } catch (e) {
        logger.warn(`Failed to decode receiveLong response for resid ${resid}: ${e.message}`)
    }
    return null
  }

  /**
   * 发送原始包
   * @param session - 会话对象
   * @param cmd - 命令名称
   * @param content - 数据内容
   * @returns 解码后的响应数据或null
   */
  async sendRawPacket(session: Session, cmd: string, content: any): Promise<any> {
    const encodedData = this.encoder.encode(typeof content === 'object' ? this.processJson(content) : this.processJson(JSON.parse(content)))
    const hexString = Buffer.from(encodedData).toString('hex')
    const resp = await session.onebot._request('send_packet', { cmd, data: hexString })
    try {
      return resp?.data ? this.encoder.decode(resp.data) : null
    } catch (e) {
      logger.warn(`Failed to decode sendRawPacket response for cmd ${cmd}: ${e.message}`)
      return null;
    }
  }

  /**
   * 注册数据包相关命令
   * @param onebot - onebot命令实例
   */
  registerPacketCommands(onebot: Command): void {

    const pb = onebot.subcommand('pb <elements:text>', '发送 PB 元素')
      .usage('发送 pb(elem) 数据')
      .action(async ({ session }, elements) => {
        if (session.bot.platform !== 'onebot') return;
        if (!elements?.trim()) return '请提供数据'
        const result = JSON.parse(elements)
        if (!Array.isArray(result)) return '非数组数据'
        await this.sendProtobufElements(session, result)
      })

    pb.subcommand('.raw <cmd:text> <content:text>', '发送 PB 数据')
      .usage('发送 pb 数据')
      .action(async ({ session }, cmd, content) => {
        if (session.bot.platform !== 'onebot') return;
        if (!cmd?.trim() || !content?.trim()) return '请提供数据'
        const result = JSON.parse(content)
        const response = await this.sendRawPacket(session, cmd.trim(), result)
        return JSON.stringify(response, jsonReplacer, 2)
      })

    pb.subcommand('.get [messageId:text]', '获取 PB 数据')
      .option('seq', '-s 使用 seq 而非 messageId')
      .usage('获取消息的 protobuf 数据\n不提供 messageId 时自动使用引用消息')
      .action(async ({ session, options }, messageId) => {
        if (session.bot.platform !== 'onebot') return;
        const replyData = session.event._data?.message?.find(msg => msg.type === 'reply')
        if (replyData?.data?.id) {
          const quotedMsgInfo = await session.onebot._request('get_msg', { message_id: replyData.data.id })
          const realSeq = quotedMsgInfo?.data?.real_seq
          if (realSeq) {
            const seq = typeof realSeq === 'string' ? parseInt(realSeq) : realSeq
            const data = await this.getMessage(session, seq.toString(), true)
            return data ? JSON.stringify(data, jsonReplacer, 2) : '获取消息失败'
          }
        }
        if (!messageId?.trim()) return '请提供 ID'
        const data = await this.getMessage(session, messageId, options.seq)
        return data ? JSON.stringify(data, jsonReplacer, 2) : '获取消息失败'
      })

    const long = onebot.subcommand('long <content:text>', '发送长消息')
      .usage('输入 [JSON] 发送长消息内容')
      .action(async ({ session }, content) => {
        if (session.bot.platform !== 'onebot') return;
        if (!content?.trim()) return '请提供数据'
        const result = JSON.parse(content)
        await this.sendLongElement(session, result)
      })

    long.subcommand('.id <content:text>', '生成长消息 ResID')
      .usage('输入 [JSON] 生成长消息 ResID')
      .action(async ({ session }, content) => {
        if (session.bot.platform !== 'onebot') return;
        if (!content?.trim()) return '请提供数据'
        const result = JSON.parse(content)
        const resid = await this.sendLong(session, result)
        if (!resid) return '生成长消息失败'
        const packet = {
          "37": {
            "6": 1,
            "7": resid,
            "17": 0,
            "19": { "15": 0, "31": 0, "41": 0 }
          }
        }
        return JSON.stringify(packet, jsonReplacer, 2)
      })

    long.subcommand('.get <resid:text>', '获取长消息 PB')
      .usage('通过 ResID 获取长消息 PB 数据')
      .action(async ({ session }, resid) => {
        if (session.bot.platform !== 'onebot') return;
        if (!resid?.trim()) return '请提供 ID'
        const data = await this.receiveLong(session, resid.trim())
        if (!data) return '获取长消息失败'
        return JSON.stringify(data, jsonReplacer, 2)
      })

    onebot.subcommand('forward <nodes:text>', '发送合并转发消息')
      .usage('格式:`[QQ号 昵称]内容`，使用换行分隔节点，用户信息可选')
      .action(async ({ session }, nodesText) => {
        if (session.bot.platform !== 'onebot') return;
        if (!nodesText?.trim()) return '请提供节点内容';
        try {
          const nodeStrings = nodesText.split('\n');
          const messageElements = [];
          const authorRegex = /^\[([^\]]+)\]\s*(.*)$/;
          for (const nodeStr of nodeStrings) {
            const trimmedNode = nodeStr.trim();
            if (!trimmedNode) continue;
            let userId = session.author.userId;
            let name = session.author.name;
            let contentElements: (h | string)[] = [];
            const authorMatch = trimmedNode.match(authorRegex);
            let contentText = trimmedNode;
            if (authorMatch) {
              const authorStr = authorMatch[1].trim();
              contentText = authorMatch[2].trim();
              const spaceIndex = authorStr.indexOf(' ');
              if (spaceIndex > 0) {
                const idPart = authorStr.substring(0, spaceIndex);
                const namePart = authorStr.substring(spaceIndex + 1).trim();
                if (/^\d{5,}$/.test(idPart)) {
                  userId = idPart;
                  name = namePart;
                }
              } else {
                if (/^\d{5,}$/.test(authorStr)) {
                  userId = authorStr;
                  name = null;
                } else {
                  name = authorStr;
                }
              }
            }
            if (contentText) contentElements.push(...h.parse(contentText));
            if (contentElements.length === 0) continue;
            const authorElement = h('author', { id: userId, name });
            messageElements.push(h('message', {}, [authorElement, ...contentElements]));
          }
          if (messageElements.length === 0) return '消息节点无效';
          const forwardMessage = h('message', { forward: true }, messageElements);
          await session.send(forwardMessage);
        } catch (error) {
          return `发送失败：${error.message}`;
        }
      });
  }
}
