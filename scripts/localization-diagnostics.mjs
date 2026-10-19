// Upload only fixed classifications, never raw messages, paths or commands.
export function buildLocalizationDiagnostic(context, error, toolVersion) {
  const message = String(error?.message ?? error);
  const systemCodes = [...new Set(message.match(/\b0x[0-9a-f]{8}\b/gi) ?? [])]
    .slice(0, 4)
    .map((code) => code.toUpperCase().replace("0X", "0x"));
  const systemCode = systemCodes[0];
  const errno = [
    "EACCES",
    "EPERM",
    "ENOSPC",
    "ENOENT",
    "EBUSY",
    "ETIMEDOUT",
  ].includes(error?.code)
    ? error.code
    : undefined;
  let category = "unknown";
  if (
    errno === "ENOSPC" ||
    /0x80070070|disk.{0,12}full|磁盘空间不足/i.test(message)
  )
    category = "disk_full";
  else if (/0x800704C7|cancelled|canceled|取消.*提权/i.test(message))
    category = "uac_cancelled";
  else if (/0x80073CFF|developer mode|开发者模式|开发人员模式/i.test(message))
    category = "developer_mode";
  else if (
    errno === "EACCES" ||
    errno === "EPERM" ||
    /0x80070005|0x80073D28|access.{0,8}denied|拒绝访问|权限不足/i.test(message)
  )
    category = "permission_denied";
  else if (errno === "ETIMEDOUT" || /timed?\s*out|超时/i.test(message))
    category = "timeout";
  else if (
    errno === "EBUSY" ||
    /0x80073D02|仍在运行|进程.*未退出/i.test(message)
  )
    category = "process_busy";
  else if (
    errno === "ENOENT" ||
    /没有找到|未找到|缺失|not found/i.test(message)
  )
    category = "source_missing";
  else if (/不支持.*(?:格式|Identity|包)|unsupported/i.test(message))
    category = "unsupported_package";
  else if (/asar.*(?:损坏|无法|格式)|资源.*损坏/i.test(message))
    category = "invalid_resource";
  else if (context.step === "register_package")
    category = "registration_failed";
  return {
    version: 1,
    ...context,
    category,
    toolVersion,
    ...(systemCode && { systemCode, systemCodes }),
    ...(errno && { errno }),
  };
}
