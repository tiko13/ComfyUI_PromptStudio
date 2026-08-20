param(
    [Parameter(Mandatory = $true)]
    [string] $ConfigPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
if ([System.IO.Path]::GetExtension($ConfigPath) -ine ".json") {
    throw "The Prompt Studio Llama.cpp config must be a JSON file."
}

$configDirectory = Split-Path -Parent $ConfigPath
if (-not (Test-Path -LiteralPath $configDirectory -PathType Container)) {
    throw "The config directory does not exist: $configDirectory"
}

$config = @{}
if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    if ((Get-Item -LiteralPath $ConfigPath).Length -gt 65536) {
        throw "The Llama.cpp config exceeds the 64 KB limit."
    }
    $loaded = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -ne $loaded) {
        foreach ($property in $loaded.PSObject.Properties) {
            $config[$property.Name] = $property.Value
        }
    }
}

function Get-ConfigValue {
    param([string[]] $Names, $Default = "")
    foreach ($name in $Names) {
        if ($config.ContainsKey($name)) {
            return $config[$name]
        }
    }
    return $Default
}

function New-TextBox {
    param([string] $Text = "", [bool] $Multiline = $false)
    $control = New-Object System.Windows.Forms.TextBox
    $control.Text = $Text
    $control.Dock = [System.Windows.Forms.DockStyle]::Fill
    if ($Multiline) {
        $control.Multiline = $true
        $control.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
        $control.AcceptsReturn = $true
    }
    return $control
}

function New-ComboBox {
    param([string[]] $Items, [string] $Selected)
    $control = New-Object System.Windows.Forms.ComboBox
    $control.Dock = [System.Windows.Forms.DockStyle]::Fill
    $control.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
    [void] $control.Items.AddRange($Items)
    $control.SelectedItem = if ($Items -contains $Selected) { $Selected } else { $Items[0] }
    return $control
}

function New-NumericControl {
    param([decimal] $Minimum, [decimal] $Maximum, [decimal] $Value)
    $control = New-Object System.Windows.Forms.NumericUpDown
    $control.Dock = [System.Windows.Forms.DockStyle]::Fill
    $control.Minimum = $Minimum
    $control.Maximum = $Maximum
    $control.ThousandsSeparator = $true
    $control.Value = [Math]::Min($Maximum, [Math]::Max($Minimum, $Value))
    return $control
}

function New-DecimalControl {
    param([decimal] $Minimum, [decimal] $Maximum, [decimal] $Value, [int] $DecimalPlaces = 2, [decimal] $Increment = 0.05)
    $control = New-NumericControl $Minimum $Maximum $Value
    $control.DecimalPlaces = $DecimalPlaces
    $control.Increment = $Increment
    return $control
}

function New-BrowseField {
    param([System.Windows.Forms.TextBox] $TextBox, [string] $Title)
    $panel = New-Object System.Windows.Forms.TableLayoutPanel
    $panel.Dock = [System.Windows.Forms.DockStyle]::Fill
    $panel.ColumnCount = 2
    $panel.RowCount = 1
    [void] $panel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
    [void] $panel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::AutoSize)))
    $button = New-Object System.Windows.Forms.Button
    $button.Text = "Browse..."
    $button.AutoSize = $true
    $button.Add_Click({
        $dialog = New-Object System.Windows.Forms.OpenFileDialog
        $dialog.Title = $Title
        $dialog.Filter = "GGUF files (*.gguf)|*.gguf|All files (*.*)|*.*"
        $dialog.CheckFileExists = $true
        if ($TextBox.Text.Trim()) {
            $currentDirectory = Split-Path -Parent $TextBox.Text.Trim()
            if (Test-Path -LiteralPath $currentDirectory -PathType Container) {
                $dialog.InitialDirectory = $currentDirectory
            }
        }
        if ($dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
            $TextBox.Text = $dialog.FileName
        }
    }.GetNewClosure())
    [void] $panel.Controls.Add($TextBox, 0, 0)
    [void] $panel.Controls.Add($button, 1, 0)
    return $panel
}

function Add-Field {
    param([string] $Label, [System.Windows.Forms.Control] $Control, [int] $Row, [string] $Help = "")
    $labelControl = New-Object System.Windows.Forms.Label
    $labelControl.Text = $Label
    $labelControl.AutoSize = $true
    $labelControl.Anchor = [System.Windows.Forms.AnchorStyles]::Left
    if ($Help) {
        $toolTip.SetToolTip($labelControl, $Help)
        $toolTip.SetToolTip($Control, $Help)
    }
    [void] $layout.Controls.Add($labelControl, 0, $Row)
    [void] $layout.Controls.Add($Control, 1, $Row)
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Prompt Studio - Llama.cpp Config Builder"
$form.ClientSize = New-Object System.Drawing.Size(860, 720)
$form.MinimumSize = New-Object System.Drawing.Size(760, 680)
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.Font = New-Object System.Drawing.Font("Segoe UI", 9)

$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.Dock = [System.Windows.Forms.DockStyle]::Fill
$root.Padding = New-Object System.Windows.Forms.Padding(16)
$root.ColumnCount = 1
$root.RowCount = 4
[void] $root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize)))
[void] $root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void] $root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize)))
[void] $root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize)))

$intro = New-Object System.Windows.Forms.Label
$intro.AutoSize = $true
$intro.MaximumSize = New-Object System.Drawing.Size(810, 0)
$intro.Text = "Configure the llama-server process managed by Prompt Studio. Hover a field label for details.`r`nConfig file: $ConfigPath"
$intro.Padding = New-Object System.Windows.Forms.Padding(0, 0, 0, 10)
[void] $root.Controls.Add($intro, 0, 0)

$scroll = New-Object System.Windows.Forms.Panel
$scroll.Dock = [System.Windows.Forms.DockStyle]::Fill
$scroll.AutoScroll = $true
[void] $root.Controls.Add($scroll, 0, 1)

$layout = New-Object System.Windows.Forms.TableLayoutPanel
$layout.AutoSize = $true
$layout.AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
$layout.Dock = [System.Windows.Forms.DockStyle]::Top
$layout.ColumnCount = 2
[void] $layout.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 165)))
[void] $layout.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void] $scroll.Controls.Add($layout)
$toolTip = New-Object System.Windows.Forms.ToolTip

$modelText = New-TextBox ([string](Get-ConfigValue @("model_gguf", "model")))
$mmprojText = New-TextBox ([string](Get-ConfigValue @("mmproj_gguf", "mmproj")))
$contextSize = New-NumericControl 128 16777216 ([decimal](Get-ConfigValue @("context_size", "ctx_size") 32768))
$gpuLayers = New-TextBox ([string](Get-ConfigValue @("gpu_layers", "n_gpu_layers") "all"))
$parallelSlots = New-NumericControl 1 1024 ([decimal](Get-ConfigValue @("parallel_slots", "parallel") 1))
$cudaDevices = New-TextBox ([string](Get-ConfigValue @("cuda_devices")))
$cudaVisibleDevices = New-TextBox ([string](Get-ConfigValue @("cuda_visible_devices")))
$splitMode = New-ComboBox @("none", "layer", "row", "tensor") ([string](Get-ConfigValue @("split_mode") "layer"))
$mainGpu = New-NumericControl 0 1024 ([decimal](Get-ConfigValue @("main_gpu", "main_gpu_index") 0))
$tensorSplit = New-TextBox ([string](Get-ConfigValue @("tensor_split")))
$autoFit = New-ComboBox @("default", "on", "off") ([string](Get-ConfigValue @("auto_fit", "fit") "default"))
$flashAttention = New-ComboBox @("auto", "on", "off") ([string](Get-ConfigValue @("flash_attention", "flash_attn") "auto"))
$cacheTypes = @("f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1")
$cacheTypeK = New-ComboBox $cacheTypes ([string](Get-ConfigValue @("kv_cache_k", "cache_type_k") "f16"))
$cacheTypeV = New-ComboBox $cacheTypes ([string](Get-ConfigValue @("kv_cache_v", "cache_type_v") "f16"))
$mtpEnabled = New-ComboBox @("off", "on") ([string](Get-ConfigValue @("mtp_enabled", "mtp") "off"))
$mtpDraftTokens = New-NumericControl 1 1024 ([decimal](Get-ConfigValue @("mtp_draft_tokens", "spec_draft_n_max") 3))
$mtpMinDraftTokens = New-NumericControl 0 1024 ([decimal](Get-ConfigValue @("mtp_min_draft_tokens", "spec_draft_n_min") 0))
$mtpMinProbability = New-DecimalControl 0 1 ([decimal](Get-ConfigValue @("mtp_min_probability", "spec_draft_p_min") 0)) 3 0.05
$mtpGpuLayers = New-TextBox ([string](Get-ConfigValue @("mtp_gpu_layers", "spec_draft_gpu_layers") "auto"))
$mtpDevice = New-TextBox ([string](Get-ConfigValue @("mtp_device", "spec_draft_device")))
$mtpCacheTypeK = New-ComboBox $cacheTypes ([string](Get-ConfigValue @("mtp_kv_cache_k", "spec_draft_cache_type_k") "f16"))
$mtpCacheTypeV = New-ComboBox $cacheTypes ([string](Get-ConfigValue @("mtp_kv_cache_v", "spec_draft_cache_type_v") "f16"))
$hostText = New-TextBox ([string](Get-ConfigValue @("host") "127.0.0.1"))
$port = New-NumericControl 1 65535 ([decimal](Get-ConfigValue @("port") 8080))
$existingExtraArgs = @(Get-ConfigValue @("extra_args") @())
$extraArgs = New-TextBox (($existingExtraArgs | ForEach-Object { [string] $_ }) -join "`r`n") $true
$extraArgs.MinimumSize = New-Object System.Drawing.Size(0, 80)

Add-Field "Model GGUF" (New-BrowseField $modelText "Select model GGUF") 0 "Required model weights file."
Add-Field "MMProj GGUF" (New-BrowseField $mmprojText "Select multimodal projector GGUF") 1 "Optional multimodal projector for vision models."
Add-Field "Context size" $contextSize 2 "Maximum context tokens allocated by llama-server."
Add-Field "GPU layers" $gpuLayers 3 "Use 'all' or a non-negative layer count."
Add-Field "Parallel slots" $parallelSlots 4 "Number of concurrent llama-server slots."
Add-Field "CUDA devices" $cudaDevices 5 "Optional value for llama.cpp --device, such as CUDA0,CUDA1."
Add-Field "CUDA visible devices" $cudaVisibleDevices 6 "Optional CUDA_VISIBLE_DEVICES environment value."
Add-Field "Split mode" $splitMode 7 "How model tensors are split across GPUs."
Add-Field "Main GPU" $mainGpu 8 "Physical CUDA GPU index. When CUDA devices filters the list, Prompt Studio translates this to llama.cpp's filtered-list index."
Add-Field "Tensor split" $tensorSplit 9 "Optional comma-separated proportions, such as 2,1,1."
Add-Field "Auto-fit" $autoFit 10 "Use default to omit --fit, or explicitly turn it on/off."
Add-Field "Flash attention" $flashAttention 11 "Automatic, enabled, or disabled flash attention."
Add-Field "KV cache K" $cacheTypeK 12 "Key-cache data type."
Add-Field "KV cache V" $cacheTypeV 13 "Value-cache data type."
Add-Field "MTP" $mtpEnabled 14 "Enable the model's built-in Multi-Token Prediction head for speculative decoding. Requires a compatible MTP GGUF and recent llama.cpp build."
Add-Field "MTP draft tokens" $mtpDraftTokens 15 "Maximum number of tokens drafted per speculative-decoding step."
Add-Field "MTP minimum tokens" $mtpMinDraftTokens 16 "Minimum useful draft length. Must not exceed MTP draft tokens."
Add-Field "MTP minimum probability" $mtpMinProbability 17 "Stop drafting when the next draft token probability falls below this value (0 to 1)."
Add-Field "MTP GPU layers" $mtpGpuLayers 18 "Draft-model GPU layers: 'auto', 'all', or a non-negative layer count."
Add-Field "MTP device" $mtpDevice 19 "Optional comma-separated llama.cpp device list for the MTP draft context."
Add-Field "MTP KV cache K" $mtpCacheTypeK 20 "Key-cache data type for the MTP draft context."
Add-Field "MTP KV cache V" $mtpCacheTypeV 21 "Value-cache data type for the MTP draft context."
Add-Field "Host" $hostText 22 "Address llama-server listens on."
Add-Field "Port" $port 23 "Port llama-server listens on."
Add-Field "Extra arguments" $extraArgs 24 "Optional raw llama.cpp arguments, one token per line."

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.AutoSize = $true
$statusLabel.ForeColor = [System.Drawing.Color]::DarkGreen
$statusLabel.Padding = New-Object System.Windows.Forms.Padding(0, 8, 0, 8)
$statusLabel.Text = if (Test-Path -LiteralPath $ConfigPath) { "Existing config loaded." } else { "A new config will be created." }
[void] $root.Controls.Add($statusLabel, 0, 2)

$buttons = New-Object System.Windows.Forms.FlowLayoutPanel
$buttons.AutoSize = $true
$buttons.Dock = [System.Windows.Forms.DockStyle]::Fill
$buttons.FlowDirection = [System.Windows.Forms.FlowDirection]::RightToLeft
$saveButton = New-Object System.Windows.Forms.Button
$saveButton.Text = "Save config"
$saveButton.AutoSize = $true
$saveButton.MinimumSize = New-Object System.Drawing.Size(105, 32)
$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = "Cancel"
$cancelButton.AutoSize = $true
$cancelButton.MinimumSize = New-Object System.Drawing.Size(90, 32)
[void] $buttons.Controls.Add($saveButton)
[void] $buttons.Controls.Add($cancelButton)
[void] $root.Controls.Add($buttons, 0, 3)

$cancelButton.Add_Click({ $form.Close() })
$saveButton.Add_Click({
    try {
        $model = $modelText.Text.Trim()
        $mmproj = $mmprojText.Text.Trim()
        if (-not (Test-Path -LiteralPath $model -PathType Leaf)) {
            throw "Select an existing model GGUF file."
        }
        if ($mmproj -and -not (Test-Path -LiteralPath $mmproj -PathType Leaf)) {
            throw "The selected MMProj GGUF does not exist."
        }
        $gpuLayerValue = $gpuLayers.Text.Trim().ToLowerInvariant()
        if ($gpuLayerValue -notmatch '^(all|[0-9]+)$') {
            throw "GPU layers must be 'all' or a non-negative number."
        }
        $tensorSplitValue = $tensorSplit.Text.Trim()
        if ($tensorSplitValue -and $tensorSplitValue -notmatch '^[0-9]+(?:\.[0-9]+)?(?:,[0-9]+(?:\.[0-9]+)?)*$') {
            throw "Tensor split must be a comma-separated numeric list, such as 2,1,1."
        }
        if ($mtpMinDraftTokens.Value -gt $mtpDraftTokens.Value) {
            throw "MTP minimum tokens cannot exceed MTP draft tokens."
        }
        $mtpGpuLayerValue = $mtpGpuLayers.Text.Trim().ToLowerInvariant()
        if ($mtpGpuLayerValue -notmatch '^(auto|all|[0-9]+)$') {
            throw "MTP GPU layers must be 'auto', 'all', or a non-negative number."
        }
        $hostValue = $hostText.Text.Trim()
        if (-not $hostValue -or $hostValue -match '\s') {
            throw "Host must be non-empty and cannot contain whitespace."
        }
        $arguments = @($extraArgs.Lines | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        if ($arguments.Count -gt 128 -or ($arguments | Where-Object { $_.Length -gt 4096 -or $_.Contains([char]0) })) {
            throw "Extra arguments are too large or contain invalid values."
        }

        $savedConfig = [ordered]@{
            model_gguf = [System.IO.Path]::GetFullPath($model)
            mmproj_gguf = if ($mmproj) { [System.IO.Path]::GetFullPath($mmproj) } else { "" }
            context_size = [int] $contextSize.Value
            gpu_layers = $gpuLayerValue
            parallel_slots = [int] $parallelSlots.Value
            cuda_devices = $cudaDevices.Text.Trim()
            cuda_visible_devices = $cudaVisibleDevices.Text.Trim()
            split_mode = [string] $splitMode.SelectedItem
            main_gpu = [int] $mainGpu.Value
            tensor_split = $tensorSplitValue
            auto_fit = [string] $autoFit.SelectedItem
            flash_attention = [string] $flashAttention.SelectedItem
            kv_cache_k = [string] $cacheTypeK.SelectedItem
            kv_cache_v = [string] $cacheTypeV.SelectedItem
            mtp_enabled = [string] $mtpEnabled.SelectedItem
            mtp_draft_tokens = [int] $mtpDraftTokens.Value
            mtp_min_draft_tokens = [int] $mtpMinDraftTokens.Value
            mtp_min_probability = [double] $mtpMinProbability.Value
            mtp_gpu_layers = $mtpGpuLayerValue
            mtp_device = $mtpDevice.Text.Trim()
            mtp_kv_cache_k = [string] $mtpCacheTypeK.SelectedItem
            mtp_kv_cache_v = [string] $mtpCacheTypeV.SelectedItem
            host = $hostValue
            port = [int] $port.Value
            extra_args = $arguments
        }
        $json = $savedConfig | ConvertTo-Json -Depth 4
        $temporaryPath = "$ConfigPath.$([System.Guid]::NewGuid().ToString('N')).tmp"
        try {
            [System.IO.File]::WriteAllText($temporaryPath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
            Move-Item -LiteralPath $temporaryPath -Destination $ConfigPath -Force
        }
        finally {
            if (Test-Path -LiteralPath $temporaryPath) {
                Remove-Item -LiteralPath $temporaryPath -Force
            }
        }
        $statusLabel.ForeColor = [System.Drawing.Color]::DarkGreen
        $statusLabel.Text = "Saved Prompt Studio Llama.cpp config."
        [System.Windows.Forms.MessageBox]::Show(
            "The Llama.cpp config was saved to:`r`n$ConfigPath",
            "Prompt Studio",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null
    }
    catch {
        $statusLabel.ForeColor = [System.Drawing.Color]::DarkRed
        $statusLabel.Text = $_.Exception.Message
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            "Could not save config",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    }
})

[void] $form.Controls.Add($root)
$form.AcceptButton = $saveButton
$form.CancelButton = $cancelButton
[void] $form.ShowDialog()
