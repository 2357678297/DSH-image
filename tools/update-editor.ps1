#Requires -Version 5.1
# Local maintainer UI; it never starts a server. Version, notes and confirmation travel in stdin, never on a shell command line.
[CmdletBinding()]
param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw '原生更新编辑器仅支持 Windows；其它平台请使用 release-guard.mjs 命令行。' }
if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
    $winPS = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $extra = @(); if ($SelfTest) { $extra += '-SelfTest' }
    & $winPS -NoProfile -STA -File $PSCommandPath @extra
    exit $LASTEXITCODE
}
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$repo = (Get-Item -LiteralPath $PSScriptRoot).Parent.FullName
$state = $null; $operation = $null; $rendering = $false; $fresh = $false; $priorError = ''
$captions = @{status='读取仓库';load='载入已存草稿';save='保存草稿';prepare='准备版本';reopen='返回编辑';verify='运行校验';publish='发布更新'}
$stages = @{editing='编辑中';prepared='已准备 · 待校验';verified='校验通过';pendingPush='已生成本地版本 · 待推送'}
$newline = [Environment]::NewLine

function New-Column([single]$Percent) {
    [Windows.Forms.ColumnStyle]::new([Windows.Forms.SizeType]::Percent, $Percent)
}
function Add-Row($Panel,[string]$Type,[single]$Size) {
    [void]$Panel.RowStyles.Add([Windows.Forms.RowStyle]::new([Windows.Forms.SizeType]$Type,$Size))
}
function New-Grid([int]$Rows) {
    $p = [Windows.Forms.TableLayoutPanel]::new(); $p.Dock='Fill'; $p.RowCount=$Rows; $p.ColumnCount=1
    [void]$p.ColumnStyles.Add((New-Column 100)); $p.Margin=[Windows.Forms.Padding]::new(0); return $p
}
function New-Label([string]$Text,[bool]$Bold=$false) {
    $l=[Windows.Forms.Label]::new(); $l.Text=$Text; $l.AutoSize=$true; $l.Anchor='Left'; $l.UseMnemonic=$false
    $l.Margin=[Windows.Forms.Padding]::new(0,3,0,4)
    if ($Bold) { $l.Font=[Drawing.Font]::new($form.Font,[Drawing.FontStyle]::Bold) }; return $l
}
function New-Text([string]$Name,[bool]$Multi,[bool]$ReadOnly=$false) {
    $c=[Windows.Forms.TextBox]::new(); $c.AccessibleName=$Name; $c.Multiline=$Multi; $c.ReadOnly=$ReadOnly; $c.Dock='Fill'
    if($Multi){$c.ScrollBars='Vertical';$c.AcceptsReturn=(-not $ReadOnly)}; $c.Margin=[Windows.Forms.Padding]::new(0,0,4,3); return $c
}
function New-Button([string]$Text) {
    $b=[Windows.Forms.Button]::new(); $b.Text=$Text; $b.AutoSize=$true; $b.AutoSizeMode='GrowAndShrink'
    $b.MinimumSize=[Drawing.Size]::new(82,34); $b.Margin=[Windows.Forms.Padding]::new(0,1,6,1); $b.UseVisualStyleBackColor=$true; return $b
}
$form=[Windows.Forms.Form]::new(); $form.Text='更新编辑器 · 本地发布守卫'; $form.StartPosition='CenterScreen'
$form.Font=[Drawing.SystemFonts]::MessageBoxFont; $form.AutoScaleMode='Font'; $form.MinimumSize=[Drawing.Size]::new(800,560); $form.ClientSize=[Drawing.Size]::new(940,618)
$layout=New-Grid 6; $layout.Padding=[Windows.Forms.Padding]::new(18,12,18,12); $form.Controls.Add($layout)
Add-Row $layout Absolute 32; Add-Row $layout Absolute 28; Add-Row $layout Percent 100; Add-Row $layout Absolute 36; Add-Row $layout Absolute 66; Add-Row $layout Absolute 42
$title=New-Label '更新编辑器　／　本地发布守卫' $true; $title.Font=[Drawing.Font]::new($form.Font.FontFamily,14,[Drawing.FontStyle]::Bold); $layout.Controls.Add($title,0,0)
$summary=New-Label '正在读取维护仓库…'; $layout.Controls.Add($summary,0,1)
$body=[Windows.Forms.TableLayoutPanel]::new(); $body.Dock='Fill'; $body.ColumnCount=2; $body.RowCount=1; $body.Margin=[Windows.Forms.Padding]::new(0)
[void]$body.ColumnStyles.Add((New-Column 43)); [void]$body.ColumnStyles.Add((New-Column 57)); Add-Row $body Percent 100; $layout.Controls.Add($body,0,2)
$left=New-Grid 4; $left.Padding=[Windows.Forms.Padding]::new(0,0,12,0); $body.Controls.Add($left,0,0)
Add-Row $left Absolute 30; Add-Row $left Percent 50; Add-Row $left Absolute 30; Add-Row $left Percent 50
$left.Controls.Add((New-Label '待发布的提交（最近 50 条）' $true),0,0); $commits=New-Text '待发布的提交' $true $true; $left.Controls.Add($commits,0,1)
$left.Controls.Add((New-Label '工作区改动（请先审查并自行提交功能改动）' $true),0,2); $files=New-Text '工作区改动' $true $true; $left.Controls.Add($files,0,3)
$right=New-Grid 4; $body.Controls.Add($right,1,0); Add-Row $right Absolute 30; Add-Row $right Absolute 32; Add-Row $right Absolute 30; Add-Row $right Percent 100
$right.Controls.Add((New-Label '目标版本　例如 0.3.0，不带 v' $true),0,0); $versionBox=New-Text '目标版本' $false; $versionBox.MaxLength=35; $right.Controls.Add($versionBox,0,1)
$right.Controls.Add((New-Label '更新说明　／　将随版本记录一起发布' $true),0,2); $notesBox=New-Text '更新说明' $true; $notesBox.MaxLength=16000; $right.Controls.Add($notesBox,0,3)
$stage=New-Label '尚未加载'; $layout.Controls.Add($stage,0,3); $message=New-Text '操作结果与守卫提示' $true $true; $layout.Controls.Add($message,0,4)
$bar=[Windows.Forms.FlowLayoutPanel]::new(); $bar.Dock='Fill'; $bar.WrapContents=$false; $bar.Margin=[Windows.Forms.Padding]::new(0,5,0,0); $layout.Controls.Add($bar,0,5)
$buttons=@{}; foreach($item in @('status','save','prepare','verify','publish','reopen','load')) {
    $b=New-Button $captions[$item]; $b.Tag=$item; $buttons[$item]=$b; $bar.Controls.Add($b)
}; $buttons.status.Text='刷新状态'
$timer=[Windows.Forms.Timer]::new(); $timer.Interval=120
function Normalize-Notes([string]$s) { return (($s -replace "`r`n?","`n").Trim()) }
function Test-MatchesDraft {
    return ($null -ne $state.draft -and $versionBox.Text.Trim() -ceq [string]$state.draft.version -and (Normalize-Notes $notesBox.Text) -ceq (Normalize-Notes $state.draft.notes))
}
function Test-Dirty {
    if ($null -eq $state.draft) { return ($versionBox.Text.Trim().Length -gt 0 -or (Normalize-Notes $notesBox.Text).Length -gt 0) }; return (-not (Test-MatchesDraft))
}
function Update-Gates {
    if($rendering) {return}; $idle=$null -eq $operation; $available=$idle -and $fresh -and $null -ne $state
    $editing=$state.phase -eq 'editing'; $matched=Test-MatchesDraft; $dirty=Test-Dirty
    $versionBox.ReadOnly= -not ($idle -and $editing); $notesBox.ReadOnly=$versionBox.ReadOnly
    $buttons.status.Enabled=$idle; $buttons.save.Enabled=$available -and $editing -and $versionBox.Text.Trim().Length -gt 0 -and (Normalize-Notes $notesBox.Text).Length -gt 0
    $buttons.prepare.Enabled=$available -and $editing -and $matched -and $state.draft.base -ceq $state.head -and @($state.files).Count -eq 0
    $buttons.reopen.Enabled=$available -and $matched -and $state.phase -in @('prepared','verified')
    $buttons.load.Enabled=$available -and $null -ne $state.draft -and $dirty
    $buttons.verify.Enabled=$buttons.reopen.Enabled
    $buttons.publish.Enabled=$available -and $matched -and $state.phase -in @('verified','pendingPush') -and $state.target -ceq ('v'+$state.draft.version)
    $buttons.publish.Text=if ($state.phase -eq 'pendingPush') {'重试推送…'} else {'发布更新…'}
    if (-not $idle) { $stage.Text='进行中：'+$captions[$operation.Verb]+'　·　请等待守卫完成，不要关闭窗口。' }
    elseif (-not $fresh) { $stage.Text='未取得最新仓库状态，请刷新后再操作。' }
    elseif (-not $editing -and $dirty) { $stage.Text='已保留本窗口的未保存输入，可先复制。要继续操作，请显式载入已存草稿。' }
    else {
        $hint=switch ($state.phase){
            'editing' { if($dirty){'输入尚未保存'} elseif (-not $state.draft){'先填写版本和更新说明'} elseif ($state.draft.base -cne $state.head){'HEAD 已变化，请核对提交并重新保存草稿'} elseif (@($state.files).Count){'请先提交或整理工作区，再准备版本'} else {'草稿已保存，可准备版本'} }
            'prepared' {'可以运行校验；修改草稿请先返回编辑'}
            'verified' {'已校验的快照可发布；改动后须重新校验'}
            'pendingPush' {'保留同一个发布提交；确认后仅继续本次发布'}
            default {'请刷新状态'}
        }; $stage.Text=('状态：{0}　·　{1}' -f $stages[[string]$state.phase],$hint)
    }
}
function Set-GuardState($new,[bool]$keepInput) {
    if ($null -eq $new -or $new.phase -notin @('editing','prepared','verified','pendingPush')) {throw '守卫返回未知状态，请刷新。'}
    $script:rendering=$true; $script:state=$new; $script:fresh=$true
    try {
        $h=[string]$new.head; $summary.Text="当前版本 v$($new.version)　·　$($new.branch)　·　HEAD $($h.Substring(0,[Math]::Min(10,$h.Length)))"
        $c=@($new.commits | Where-Object {$_}); $f=@($new.files | Where-Object {$_})
        $commits.Text=if($c.Count){$c -join $newline}else{'自上次发布后暂无新提交。'}
        $files.Text=if($f.Count){$f -join $newline}else{'工作区干净。'}
        if(-not $keepInput) {
            $versionBox.Text=[string]$new.draft.version; $notesBox.Text=([string]$new.draft.notes -replace "`r?`n",$newline)
        }
    } finally { $script:rendering=$false }; Update-Gates
}
function Get-ConfirmationText {
    $next=if ($state.phase -eq 'pendingPush') {'仅重试本次发布，不会改推其他提交。'} else {'确认后将提交发布文件并推送分支与标签。'}
    return "标签：$($state.target)`r`n目标：$($state.remote)`r`n分支：$($state.branch)`r`n当前 HEAD：$($state.head)`r`n已校验的基线提交：$($state.verifiedSha)`r`n$next"
}
function Confirm-Release {
    $dialog=[Windows.Forms.Form]::new(); $dialog.Text='确认发布目标'; $dialog.Font=$form.Font; $dialog.StartPosition='CenterParent'; $dialog.ClientSize=[Drawing.Size]::new(590,300); $dialog.FormBorderStyle='FixedDialog'; $dialog.MinimizeBox=$false; $dialog.MaximizeBox=$false
    try {
        $p=New-Grid 4; $p.Padding=[Windows.Forms.Padding]::new(14); $dialog.Controls.Add($p)
        Add-Row $p Percent 100; Add-Row $p Absolute 30; Add-Row $p Absolute 32; Add-Row $p Absolute 44
        $info=New-Text '发布目标' $true $true; $info.Text=Get-ConfirmationText; $p.Controls.Add($info,0,0)
        $p.Controls.Add((New-Label ('输入完整标签确认（区分大小写）：'+$state.target) $true),0,1)
        $confirmation=New-Text '输入确认标签' $false; $p.Controls.Add($confirmation,0,2)
        $row=[Windows.Forms.FlowLayoutPanel]::new(); $row.Dock='Fill'; $row.FlowDirection='RightToLeft'; $p.Controls.Add($row,0,3)
        $ok=New-Button '确认发布'; $ok.Enabled=$false; $ok.DialogResult='OK'; $row.Controls.Add($ok)
        $cancel=New-Button '取消'; $cancel.DialogResult='Cancel'; $row.Controls.Add($cancel); $dialog.CancelButton=$cancel
        $confirmation.Add_TextChanged({$ok.Enabled=$confirmation.Text -ceq $state.target}); $dialog.Add_Shown({[void]$confirmation.Focus()})
        if($dialog.ShowDialog($form) -eq 'OK' -and $confirmation.Text -ceq $state.target){return $confirmation.Text}; return ''
    } finally { $dialog.Dispose() }
}
function Start-Guard([ValidateSet('status','save','prepare','reopen','verify','publish')][string]$verb,[hashtable]$body) {
    if ($operation -or -not $buttons[$verb].Enabled) {return}
    $keep = $verb -eq 'status' -and (Test-Dirty)
    if ($verb -ne 'status') { $body.expected=$state.revision }
    $p=[Diagnostics.Process]::new(); $p.StartInfo.FileName=(Get-Command 'node.exe' -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $p.StartInfo.WorkingDirectory=$repo; $p.StartInfo.Arguments='tools/release-guard.mjs '+$verb; $p.StartInfo.UseShellExecute=$false; $p.StartInfo.CreateNoWindow=$true
    $p.StartInfo.RedirectStandardInput=$true; $p.StartInfo.RedirectStandardOutput=$true; $p.StartInfo.RedirectStandardError=$true
    $utf8=[Text.UTF8Encoding]::new($false); $p.StartInfo.StandardOutputEncoding=$utf8; $p.StartInfo.StandardErrorEncoding=$utf8
    try {
        [void]$p.Start(); $out=$p.StandardOutput.ReadToEndAsync(); $err=$p.StandardError.ReadToEndAsync()
        $bytes=$utf8.GetBytes((ConvertTo-Json $body -Compress)); $inStream=$p.StandardInput.BaseStream
        $write=$inStream.WriteAsync($bytes,0,$bytes.Length)
        $script:operation=@{Verb=$verb;Keep=$keep;Process=$p;Out=$out;Err=$err;Write=$write;Stream=$inStream}
        Update-Gates; $timer.Start()
    } catch { $p.Dispose(); throw }
}
$timer.Add_Tick({
    $op=$script:operation; if(-not $op){return}
    if ($op.Stream -and $op.Write.IsCompleted) { try{$op.Stream.Close()}catch{}; $op.Stream=$null }
    if(-not ($op.Process.HasExited -and $op.Out.IsCompleted -and $op.Err.IsCompleted)){return}
    $timer.Stop(); $script:operation=$null
    try {
        $reply=ConvertFrom-Json -InputObject $op.Out.GetAwaiter().GetResult() -ErrorAction Stop
        if(-not $reply.ok -or $op.Process.ExitCode -ne 0){throw ([string]$reply.error)}
        Set-GuardState $reply.state $op.Keep
        if ($op.Verb -eq 'status' -and $script:priorError) { $message.Text=$script:priorError; $script:priorError='' }
        else { $message.Text = switch ($op.Verb){'status'{"仓库：$repo`r`n推送目标：$($state.remote)"};'save'{'本地草稿已保存。未修改版本文件，也未发布。'};'prepare'{"已同步目标版本并生成 $($state.notesPath)。尚未提交。"};'reopen'{'已撤回准备，保留原草稿。'};'verify'{'版本一致性和测试通过，等待你确认发布。'};'publish'{"发布完成：v$($state.version) · $($state.head)。未重启 DSH。"}} }
    } catch {
        $failure='操作未完成：'+$_.Exception.Message; $detail=$op.Err.GetAwaiter().GetResult().Trim(); if($detail){$failure+="`r`n"+$detail.Substring(0,[Math]::Min($detail.Length,1400))}
        $script:fresh=$false; $message.Text=$failure; Update-Gates
        # An unsuccessful push can still have created the local commit/tag. Re-read only; never retry mutations automatically.
        if($op.Verb -ne 'status') { $script:priorError=$failure; try {Start-Guard status @{}} catch { $message.Text=$failure+"`r`n刷新失败："+$_.Exception.Message } }
    } finally { $op.Process.Dispose(); Update-Gates }
})
foreach ($b in $buttons.Values) { $b.Add_Click({ param($sender,$eventArgs)
    $verb=[string]$sender.Tag; $body=@{}
    if($verb -eq 'load') {
        if($buttons.load.Enabled -and [Windows.Forms.MessageBox]::Show($form,'以守卫已保存的草稿替换本窗口输入？尚未保存的文字将丢失。','载入已存草稿','YesNo','Question','Button2') -eq 'Yes'){Set-GuardState $state $false; $message.Text='已载入已保存的草稿，未执行发布操作。'}
        return
    }
    if($verb -eq 'publish') { $confirm=Confirm-Release; if(-not $confirm){return}; $body.confirm=$confirm }
    if($verb -eq 'reopen' -and [Windows.Forms.MessageBox]::Show($form,'撤回由守卫生成的版本文件调整和发布说明？草稿会保留，此次校验将失效。','返回编辑','YesNo','Question','Button2') -ne 'Yes'){return}
    if($verb -eq 'save') {$body.version=$versionBox.Text.Trim(); $body.notes=Normalize-Notes $notesBox.Text}
    try{Start-Guard $verb $body}catch{$message.Text='无法启动守卫：'+$_.Exception.Message; Update-Gates}
}) }
$versionBox.Add_TextChanged({Update-Gates}); $notesBox.Add_TextChanged({Update-Gates})
$form.Add_FormClosing({param($sender,$e)
    if($operation){$e.Cancel=$true; $message.Text='守卫操作仍在进行。请等待操作完成再关闭。'; return}
    if((Test-Dirty) -and [Windows.Forms.MessageBox]::Show($form,'有未保存的版本或更新说明。放弃这次输入并关闭？','未保存的草稿','YesNo','Warning','Button2') -ne 'Yes'){$e.Cancel=$true}
})
try {
    Update-Gates
    if($SelfTest){
        # Exercise the actual controls, no ShowDialog, no guard call or repository writes.
        $sample=[pscustomobject]@{version='1.0.0';head='abcdef123456';branch='main';files=@();commits=@();phase='editing';remote='local-test';target='v1.0.1';revision='fixture';verifiedSha='abc123456789';draft=[pscustomobject]@{version='1.0.1';notes="测试`n第二行";base='abcdef123456'}}
        Set-GuardState $sample $false
        if(-not $buttons.prepare.Enabled -or $buttons.publish.Enabled -or $notesBox.Text -cne "测试`r`n第二行"){throw '草稿绑定或中文换行不正确'}
        $notesBox.Text='未保存'; Update-Gates; if($buttons.prepare.Enabled -or -not $buttons.save.Enabled){throw '未保存的文本不应进入准备'}
        if($notesBox.MaxLength -ne 16000){throw '更新说明长度上限错误'}
        $sample.phase='verified'; Set-GuardState $sample $true; Set-GuardState $sample $true
        if($notesBox.Text -cne '未保存' -or -not $buttons.load.Enabled -or $buttons.publish.Enabled -or $buttons.reopen.Enabled -or $buttons.verify.Enabled){throw '多窗口刷新不得替换本地输入或误开放发布'}
        foreach($phase in @('prepared','verified','pendingPush')){$sample.phase=$phase;Set-GuardState $sample $false; if(-not $notesBox.ReadOnly -or $buttons.publish.Enabled -ne ($phase -in @('verified','pendingPush')) -or $buttons.reopen.Enabled -ne ($phase -in @('prepared','verified'))){throw "阶段按钮错误：$phase"}}
        if((Get-ConfirmationText) -notmatch [regex]::Escape('当前 HEAD：'+$sample.head) -or (Get-ConfirmationText) -notmatch [regex]::Escape('已校验的基线提交：'+$sample.verifiedSha) -or $buttons.reopen.Enabled){throw '待推送确认缺失提交核对或错误开放撤回'}
        Write-Output '更新编辑器自测通过：草稿、未保存输入、多窗口刷新、撤回与待推送校验。未调用守卫。' ; return
    }
    $form.Add_Shown({try{Start-Guard status @{}}catch{$message.Text='无法读取仓库：'+$_.Exception.Message}})
    [void]$form.ShowDialog()
} finally { $timer.Dispose(); $form.Dispose() }
