"""Folder Type contract shared by Image and Video adapter loaders."""


def normalized_folder_type(value):
    value = str(value or "").strip()
    if not value or value in {".", ".."} or "/" in value or "\\" in value:
        return ""
    return value


def matches_folder_type(name, folder_type):
    folder_type = normalized_folder_type(folder_type)
    parts = str(name or "").replace("\\", "/").strip("/").split("/")
    return bool(folder_type and not parts[-1].startswith("_") and (
        folder_type == "*" or (len(parts) > 1 and parts[0].casefold() == folder_type.casefold())))
