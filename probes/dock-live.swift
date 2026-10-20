import AppKit
import CoreMedia
import CoreVideo
import Darwin
import Foundation
import ScreenCaptureKit

// Independent research capture, local statistics only. No permission requests or pixel files.
func fail(_ message: String, _ code: Int32 = 64) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8)); exit(code)
}
func rectangle(_ r: CGRect) -> [String: Double] { ["x":r.minX,"y":r.minY,"width":r.width,"height":r.height] }
var timebase = mach_timebase_info_data_t()
func seconds(_ ticks: UInt64) -> Double { Double(ticks) * Double(timebase.numer) / Double(timebase.denom) / 1_000_000_000 }
func age(_ now: UInt64, _ before: UInt64) -> Double { now >= before ? seconds(now-before) : -seconds(before-now) }
struct Options {
    var duration = 15.0; var interval = 0.1; var threshold = 128; var maxAge = 1.0; var callbackTimeout=1.0; var idleCurrent=false
    var windowID: UInt32?; var output: String?; var appStatus = false; var scenario = "baseline"; var overlay = false; var orientation = "bottom"
    static func parse() -> Options {
        var o = Options(); o.appStatus=Bundle.main.bundleURL.pathExtension=="app"; var durationExplicit = false
        var args = Array(CommandLine.arguments.dropFirst())
        while !args.isEmpty {
            let flag = args.removeFirst()
            if flag == "--help" {
                print("dock-live [--duration 0.1..120] [--interval 0.05..5] [--threshold 1..255] [--max-frame-age 0.05..10] [--window-id ID] [--scenario LABEL] [--output ABSOLUTE_NEW.jsonl] [--app-status] [--idle-current] [--callback-timeout 0.05..10] [--overlay] [--orientation bottom|left|right]")
                print("Optimized build required. Existing screen-capture grant only; no request APIs, images, audio or uploads. Raster statistics never establish a product support edge.")
                exit(0)
            }
            if flag == "--idle-current" { o.idleCurrent=true;continue }
            if flag == "--overlay" { o.overlay=true; continue }
            if flag == "--app-status" { o.appStatus = true; continue }
            guard !args.isEmpty else { fail("Missing value for \(flag)") }
            let value = args.removeFirst()
            switch flag {
            case "--duration": guard let n=Double(value), n.isFinite, (0.1...120).contains(n) else { fail("Invalid duration") }; o.duration=n; durationExplicit=true
            case "--interval": guard let n=Double(value), n.isFinite, (0.05...5).contains(n) else { fail("Invalid interval") }; o.interval=n
            case "--callback-timeout": guard let n=Double(value),n.isFinite,(0.05...10).contains(n) else { fail("Invalid callback timeout") };o.callbackTimeout=n
            case "--max-frame-age": guard let n=Double(value), n.isFinite, (0.05...10).contains(n) else { fail("Invalid frame age") }; o.maxAge=n
            case "--threshold": guard let n=Int(value), (1...255).contains(n) else { fail("Invalid alpha threshold") }; o.threshold=n
            case "--window-id": guard let n=UInt32(value), n>0 else { fail("Invalid window ID") }; o.windowID=n
            case "--orientation": guard ["bottom","left","right"].contains(value) else { fail("Invalid orientation") }; o.orientation=value
            case "--scenario": guard !value.isEmpty, value.utf8.count<=80 else { fail("Invalid scenario label") }; o.scenario=value
            case "--output": guard value.hasPrefix("/") else { fail("Output must be an absolute NEW local file") }; o.output=value
            default: fail("Unknown option: \(flag)")
            }
        }
        if o.appStatus && !durationExplicit { o.duration=120 }
        if o.appStatus && o.output == nil { o.output=NSTemporaryDirectory()+"mosey-dock-live-"+UUID().uuidString+".jsonl" }
        return o
    }
}
final class JSONLog: @unchecked Sendable {
    let lock=NSLock(); let file: FileHandle
    init(_ path: String?) {
        if let path {
            let descriptor = open(path, O_WRONLY|O_CREAT|O_EXCL, S_IRUSR|S_IWUSR)
            guard descriptor>=0 else { fail("Cannot create new local log: \(path)",73) }
            file=FileHandle(fileDescriptor:descriptor, closeOnDealloc:true)
        } else { file=FileHandle.standardOutput }
    }
    func emit(_ record: [String:Any]) {
        lock.lock(); defer { lock.unlock() }
        guard let data=try? JSONSerialization.data(withJSONObject:record,options:[.sortedKeys]) else { fail("Cannot serialize live record",70) }
        do { try file.write(contentsOf:data); try file.write(contentsOf:Data([10])) } catch { fail("Local log write failed",74) }
    }
}
@MainActor final class StatusUI: NSObject, NSWindowDelegate {
    let window=NSWindow(contentRect:NSRect(x:0,y:0,width:540,height:230),styleMask:[.titled,.closable],backing:.buffered,defer:false)
    let text=NSTextField(wrappingLabelWithString:"")
    var requestedQuit=false
    init(logPath:String) {
        super.init()
        let app=NSApplication.shared; app.setActivationPolicy(.regular)
        window.title="Mosey Dock Live Probe"; window.delegate=self
        text.frame=NSRect(x:20,y:65,width:500,height:145); text.isSelectable=true
        text.stringValue="Checking existing screen-recording permission…\nLocal log: \(logPath)\nNo permission request will be made."
        window.contentView?.addSubview(text)
        let quit=NSButton(title:"Quit",target:self,action:#selector(quitProbe)); quit.frame=NSRect(x:420,y:15,width:100,height:32)
        window.contentView?.addSubview(quit); window.center(); window.makeKeyAndOrderFront(nil); app.activate(ignoringOtherApps:true)
    }
    func update(_ status:String,_ logPath:String) { text.stringValue="\(status)\n\nLocal log: \(logPath)\nResearch identity only; not final Electron packaging." }
    @objc func quitProbe() { requestedQuit=true }
    func windowShouldClose(_ sender:NSWindow)->Bool { requestedQuit=true; return false }
}

// Same alpha-threshold / four-connected flood-fill algorithm as dock-alpha.swift,
// adapted to row-strided BGRA and summaries so pixels never leave the process.
func analyze(_ buffer: CVPixelBuffer, threshold:Int, orientation:String) -> (stats:[String:Any],contour:[Int])? {
    guard CVPixelBufferGetPixelFormatType(buffer)==kCVPixelFormatType_32BGRA,
          CVPixelBufferLockBaseAddress(buffer,.readOnly)==kCVReturnSuccess else { return nil }
    defer { CVPixelBufferUnlockBaseAddress(buffer,.readOnly) }
    let width=CVPixelBufferGetWidth(buffer),height=CVPixelBufferGetHeight(buffer),stride=CVPixelBufferGetBytesPerRow(buffer)
    guard width>0,height>0,width<=16384,height<=16384,width*height<=50_000_000,
          let base=CVPixelBufferGetBaseAddress(buffer)?.assumingMemoryBound(to:UInt8.self) else { return nil }
    var mask=[UInt8](repeating:0,count:width*height)
    var count=0; var nonzero=0; var minX=width; var minY=height; var maxX = -1; var maxY = -1
    var rawTop=[Int](repeating:-1,count:orientation=="bottom" ? width:height)
    for y in 0..<height { for x in 0..<width {
        let alpha=Int(base[y*stride+x*4+3]); if alpha>0 { nonzero+=1 }
        if alpha>=threshold {
            mask[y*width+x]=1; count+=1
            minX=min(minX,x); minY=min(minY,y); maxX=max(maxX,x); maxY=max(maxY,y)
            let axis=orientation=="bottom" ? x:y, value=orientation=="bottom" ? y:x
            if rawTop[axis] == -1 { rawTop[axis]=value }
            else { rawTop[axis]=orientation=="left" ? max(rawTop[axis],value):min(rawTop[axis],value) }
        }
    }}
    func bounds(_ n:Int,_ x:Int,_ y:Int,_ xx:Int,_ yy:Int)->Any { n==0 ? NSNull() : ["x":x,"y":y,"width":xx-x+1,"height":yy-y+1] }
    func contourSummary(_ top:[Int])->[String:Any] {
        let values=top.filter { $0>=0 }
        var hash:UInt64=14695981039346656037
        for value in top { hash=(hash ^ UInt64(value+1)) &* 1099511628211 }
        return ["axisCount":values.count,"minInwardCoordinate":values.min() as Any? ?? NSNull(),"maxInwardCoordinate":values.max() as Any? ?? NSNull(),"fnv1a64":String(hash,radix:16)]
    }
    let raw:[String:Any]=["selectedPixelCount":count,"nonzeroAlphaPixelCount":nonzero,"boundsPixels":bounds(count,minX,minY,maxX,maxY),"inwardContourSummaryPixels":contourSummary(rawTop)]
    var best=0; var components=0; var bestBounds:Any=NSNull(); var bestTop=[Int](repeating:-1,count:rawTop.count)
    var top=[Int](repeating:-1,count:rawTop.count); var touched:[Int]=[]; var stack:[Int32]=[]
    for seed in mask.indices where mask[seed] != 0 {
        components+=1; var size=0; var x0=width; var y0=height; var x1 = -1; var y1 = -1
        func enqueue(_ index:Int) { if mask[index] != 0 { mask[index]=0; stack.append(Int32(index)) } }
        enqueue(seed)
        while let stored=stack.popLast() {
            let index=Int(stored),x=index%width,y=index/width; size+=1
            x0=min(x0,x); y0=min(y0,y); x1=max(x1,x); y1=max(y1,y)
            let axis=orientation=="bottom" ? x:y, value=orientation=="bottom" ? y:x
            if top[axis] == -1 { top[axis]=value; touched.append(axis) }
            else { top[axis]=orientation=="left" ? max(top[axis],value):min(top[axis],value) }
            if x>0 { enqueue(index-1) }; if x+1<width { enqueue(index+1) }
            if y>0 { enqueue(index-width) }; if y+1<height { enqueue(index+width) }
        }
        if size>best { best=size; bestBounds=bounds(size,x0,y0,x1,y1); bestTop=top }
        for x in touched { top[x] = -1 }; touched.removeAll(keepingCapacity:true)
    }
    return (stats:["width":width,"height":height,"orientation":orientation,"raw":raw,"largestComponent":["selectedPixelCount":best,"boundsPixels":bestBounds,"componentCount":components,"inwardContourSummaryPixels":contourSummary(bestTop)],"actualAlphaZero":nonzero==0,"fullySelectedRaster":count==width*height],contour:bestTop)
}

func attachmentRect(_ value:Any?)->CGRect? {
    guard let d=value as? [String:Any] else { return nil }
    func number(_ key:String)->Double? { (d[key] as? NSNumber)?.doubleValue ?? (d[key.prefix(1).uppercased()+key.dropFirst()] as? NSNumber)?.doubleValue }
    guard let x=number("x"),let y=number("y"),let w=number("width"),let h=number("height"),[x,y,w,h].allSatisfy({$0.isFinite}) else { return nil }
    return CGRect(x:x,y:y,width:w,height:h)
}
@MainActor final class LiveContour {
    final class Canvas:NSView {
        var values:[Int]=[]; var scale=1.0; var orientation="bottom"
        override func draw(_ dirtyRect:NSRect) {
            NSColor.cyan.setStroke();let path=NSBezierPath();path.lineWidth=2
            for (axis,value) in values.enumerated() where value>=0 {
                if orientation=="bottom" {
                    let y=bounds.height-Double(value)/scale
                    path.move(to:NSPoint(x:Double(axis)/scale,y:y));path.line(to:NSPoint(x:Double(axis+1)/scale,y:y))
                } else {
                    let x=Double(value+(orientation=="left" ? 1:0))/scale
                    path.move(to:NSPoint(x:x,y:bounds.height-Double(axis)/scale));path.line(to:NSPoint(x:x,y:bounds.height-Double(axis+1)/scale))
                }
            };path.stroke()
        }
    }
    let panel:NSPanel;let canvas=Canvas()
    init(_ frame:NSRect,_ scale:Double,_ orientation:String) {
        _=NSApplication.shared
        panel=NSPanel(contentRect:frame,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
        panel.isOpaque=false;panel.backgroundColor = .clear;panel.hasShadow=false;panel.level = .floating
        panel.hidesOnDeactivate=false;panel.ignoresMouseEvents=true;panel.collectionBehavior=[.canJoinAllSpaces,.fullScreenNone]
        canvas.scale=scale;canvas.orientation=orientation;panel.contentView=canvas
    }
    func update(_ values:[Int]?) {
        guard let values,values.contains(where:{$0>=0}) else { panel.orderOut(nil);canvas.values=[];return }
        canvas.values=values;canvas.needsDisplay=true;panel.orderFrontRegardless();canvas.displayIfNeeded()
    }
}
final class Receiver: NSObject, SCStreamOutput, SCStreamDelegate {
    struct Job {
        let sample:CMSampleBuffer;let info:[SCStreamFrameInfo:Any]
        let received:UInt64;let source:UInt64?;let epoch:Int;let sequence:Int
    }
    let lock=NSLock();let worker=DispatchQueue(label:"mosey.dock.alpha",qos:.utility)
    let log:JSONLog;let options:Options;let start:UInt64
    let clearBackground=CGColor(gray:0,alpha:0)
    var expectedWidth=0;var expectedHeight=0;var expectedScale=1.0
    var latestContour:[Int]?;var lastFrameStatus:Int?;var statusCounts:[String:Int]=[:]
    var invalidationReason="no_complete_frame";var status="waiting_for_complete_frame"
    var busy=false;var pending:Job?;var active=true;var epoch=0;var errorCode:Int?
    var completeSequence=0;var acceptedSequence:Int?
    var callbacks=0;var complete=0;var processed=0;var analyzed=0;var acceptedCount=0
    var pendingQueued=0;var pendingReplaced=0;var invalidatedPending=0;var supersededProcessed=0
    var incomplete=0;var idle=0;var late=0;var silenceInvalidated=false;var silenceInvalidations=0
    var lastCallback:UInt64?;var lastSource:UInt64?;var lastAcceptedSource:UInt64?;var maxCallbackGap=0.0
    init(_ log:JSONLog,_ options:Options,_ start:UInt64) { self.log=log;self.options=options;self.start=start }
    // Caller holds lock. Complete arrivals suppress old geometry immediately; only
    // the latest processed sequence can establish another diagnostic candidate.
    func clearLocked(_ reason:String,discardPending:Bool) {
        lastAcceptedSource=nil;latestContour=nil;acceptedSequence=nil
        invalidationReason=reason;status=reason
        if discardPending { if pending != nil { invalidatedPending+=1 };pending=nil }
    }
    func stop() { lock.lock();active=false;epoch+=1;clearLocked("stopped",discardPending:true);lock.unlock() }
    func invalidate(_ reason:String) { lock.lock();epoch+=1;clearLocked(reason,discardPending:true);lock.unlock() }
    func expireSilenceLocked(_ now:UInt64) {
        // Invalidate once per callback gap, including a sole in-flight worker.
        // An idle callback after a pause cannot make pre-gap work valid again.
        if let prior=lastCallback,age(now,prior)>options.callbackTimeout,!silenceInvalidated {
            silenceInvalidated=true;silenceInvalidations+=1
            epoch+=1;clearLocked("callback_silence",discardPending:true)
        }
    }
    func currentnessLocked(_ now:UInt64)->String {
        expireSilenceLocked(now)
        guard active,latestContour != nil,let source=lastAcceptedSource,
              acceptedSequence==completeSequence,pending==nil,
              let callback=lastCallback,age(now,callback)>=0,age(now,callback)<=options.callbackTimeout else { return "unavailable_or_stale" }
        let sourceAge=age(now,source)
        if sourceAge>=0 && sourceAge<=options.maxAge { return "current_from_source_age" }
        if options.idleCurrent && sourceAge>=0 && lastFrameStatus==SCFrameStatus.idle.rawValue { return "current_via_idle_heartbeat" }
        return "unavailable_or_stale"
    }
    func stream(_ stream:SCStream,didStopWithError error:Error) {
        lock.lock();errorCode=(error as NSError).code;active=false;epoch+=1;clearLocked("stream_error",discardPending:true);lock.unlock()
        log.emit(["type":"stream_error","errorDomain":(error as NSError).domain,"errorCode":(error as NSError).code,"supportEdge":NSNull()])
    }
    func stream(_ stream:SCStream,didOutputSampleBuffer sampleBuffer:CMSampleBuffer,of type:SCStreamOutputType) {
        guard type == .screen else { return }
        let received=mach_absolute_time()
        let info=(CMSampleBufferGetSampleAttachmentsArray(sampleBuffer,createIfNecessary:false) as? [[SCStreamFrameInfo:Any]])?.first ?? [:]
        let frameStatus=(info[.status] as? NSNumber)?.intValue ?? -1
        let source=(info[.displayTime] as? NSNumber)?.uint64Value
        lock.lock();callbacks+=1;lastFrameStatus=frameStatus;statusCounts[String(frameStatus),default:0]+=1
        expireSilenceLocked(received)
        if let previous=lastCallback { maxCallbackGap=max(maxCallbackGap,age(received,previous)) };lastCallback=received;silenceInvalidated=false
        guard active else { lock.unlock();return }
        if frameStatus != SCFrameStatus.complete.rawValue {
            incomplete+=1
            if frameStatus==SCFrameStatus.idle.rawValue { idle+=1;status="idle_no_new_frame" }
            else { epoch+=1;clearLocked("incomplete_status_\(frameStatus)",discardPending:true) }
            lock.unlock();return
        }
        complete+=1;completeSequence+=1;lastSource=source
        clearLocked("new_complete_pending",discardPending:false)
        let job=Job(sample:sampleBuffer,info:info,received:received,source:source,epoch:epoch,sequence:completeSequence)
        if busy {
            pendingQueued+=1;if pending != nil { pendingReplaced+=1 };pending=job
            lock.unlock();return
        }
        busy=true;lock.unlock()
        worker.async { [self] in processLoop(job) }
    }
    func processLoop(_ first:Job) {
        var next:Job?=first
        while let job=next {
            process(job)
            lock.lock()
            next=active ? pending:nil;pending=nil
            if next==nil { busy=false }
            lock.unlock()
        }
    }
    func process(_ job:Job) {
        let processingStart=mach_absolute_time()
        lock.lock();let eligible=active && job.epoch==epoch && job.sequence==completeSequence;lock.unlock()
        let sourceAge=job.source.map { age(processingStart,$0) }
        let fresh=sourceAge.map { $0>=0 && $0<=options.maxAge } ?? false
        let raster=eligible && fresh && CMSampleBufferIsValid(job.sample) ? CMSampleBufferGetImageBuffer(job.sample).flatMap { analyze($0,threshold:options.threshold,orientation:options.orientation) }:nil
        let finished=mach_absolute_time();let postAge=job.source.map { age(finished,$0) }
        let content=attachmentRect(job.info[.contentRect])
        let frameScale=(job.info[.scaleFactor] as? NSNumber)?.doubleValue
        let contentScale=(job.info[.contentScale] as? NSNumber)?.doubleValue
        let mappingValid=content.map { abs($0.minX)<0.01 && abs($0.minY)<0.01 && abs($0.width-Double(expectedWidth)/expectedScale)<0.01 && abs($0.height-Double(expectedHeight)/expectedScale)<0.01 } == true && frameScale==expectedScale && contentScale==1 && raster?.stats["width"] as? Int==expectedWidth && raster?.stats["height"] as? Int==expectedHeight
        lock.lock();processed+=1;if raster != nil { analyzed+=1 }
        let stillFresh=postAge.map { $0>=0 && $0<=options.maxAge } ?? false
        if !stillFresh { late+=1 }
        let callbackFresh=lastCallback.map { age(finished,$0)>=0 && age(finished,$0)<=options.callbackTimeout } ?? false
        let latest=job.sequence==completeSequence
        if !latest { supersededProcessed+=1 }
        let accepted=active && job.epoch==epoch && latest && stillFresh && callbackFresh && mappingValid && raster?.stats["fullySelectedRaster"] as? Bool != true
        let rejectionReason:String
        if accepted {
            acceptedCount+=1;lastAcceptedSource=job.source;acceptedSequence=job.sequence;latestContour=raster?.contour
            invalidationReason="none";status=lastFrameStatus==SCFrameStatus.idle.rawValue ? "idle_no_new_frame":"complete_raster_diagnostic"
            rejectionReason="none"
        } else {
            rejectionReason = !latest ? "superseded_by_newer_complete" : (job.epoch != epoch || !active ? invalidationReason : (job.source==nil ? "source_timestamp_unavailable":(!stillFresh ? "stale_frame":(!callbackFresh ? "callback_silence":(!mappingValid ? "mapping_unreliable":"alpha_not_isolated_or_invalid")))))
            // A superseded worker must not overwrite a newer pending/invalidation state.
            if latest && job.epoch==epoch { clearLocked(rejectionReason,discardPending:false) }
        }
        lock.unlock()
        var record:[String:Any]=["type":"frame","frameSequence":job.sequence,"elapsed":age(finished,start),"status":accepted ? "complete_raster_diagnostic":"rejected","frameStatus":SCFrameStatus.complete.rawValue,"sourceDisplayMachTicks":job.source as Any? ?? NSNull(),"receivedMachTicks":job.received,"processingStartMachTicks":processingStart,"processingEndMachTicks":finished,"callbackAgeFromDisplaySeconds":job.source.map { age(job.received,$0) } as Any? ?? NSNull(),"queueWaitSeconds":age(processingStart,job.received),"processingSeconds":age(finished,processingStart),"rejectionReason":rejectionReason,"sourceAgeAtProcessingEndSeconds":postAge as Any? ?? NSNull(),"supportEdge":NSNull(),"raster":raster?.stats as Any? ?? NSNull(),"mappingValid":mappingValid]
        if let n=job.info[.scaleFactor] as? NSNumber { record["frameScaleFactor"]=n }
        if let n=job.info[.contentScale] as? NSNumber { record["frameContentScale"]=n }
        if let content { record["frameContentRectPoints"]=rectangle(content) }
        if let screenRect=attachmentRect(job.info[.screenRect]) { record["frameScreenRectDiagnostic"]=rectangle(screenRect) }
        log.emit(record)
    }
    func overlayContour()->[Int]? {
        lock.lock();defer {lock.unlock()}
        return currentnessLocked(mach_absolute_time())=="unavailable_or_stale" ? nil:latestContour
    }
    func snapshot()->[String:Any] {
        lock.lock();defer {lock.unlock()};let now=mach_absolute_time()
        let currentness=currentnessLocked(now)
        return ["lastFrameStatusCode":lastFrameStatus as Any? ?? NSNull(),"frameStatusCounts":statusCounts,"invalidationReason":invalidationReason,"lastObservedStatus":status,"callbackCount":callbacks,"completeReceived":complete,"processedComplete":processed,"alphaAnalyzedCount":analyzed,"acceptedComplete":acceptedCount,"backpressureSkipped":pendingReplaced,"callbackSilenceInvalidations":silenceInvalidations,"pendingQueued":pendingQueued,"pendingReplaced":pendingReplaced,"pendingDiscardedOnInvalidation":invalidatedPending,"supersededProcessed":supersededProcessed,"pendingCompleteCount":pending==nil ? 0:1,"latestCompleteSequence":completeSequence,"acceptedCompleteSequence":acceptedSequence as Any? ?? NSNull(),"intervalSkipped":0,"incompleteCallbacks":incomplete,"idleCallbacks":idle,"lateComplete":late,"lastCallbackAgeSeconds":lastCallback.map { age(now,$0) } as Any? ?? NSNull(),"lastCompleteSourceAgeSeconds":lastSource.map { age(now,$0) } as Any? ?? NSNull(),"lastAcceptedSourceAgeSeconds":lastAcceptedSource.map { age(now,$0) } as Any? ?? NSNull(),"lastAcceptedSourceDisplayMachTicks":lastAcceptedSource as Any? ?? NSNull(),"maxObservedCallbackGapSeconds":maxCallbackGap,"candidateStatus":currentness,"idleCurrentPolicy":options.idleCurrent,"callbackTimeoutSeconds":options.callbackTimeout,"upstreamDroppedFrames":"not_observable","streamErrorCode":errorCode as Any? ?? NSNull(),"supportEdge":NSNull()]
    }
}

@MainActor final class NativeLifecycle:NSObject,NSApplicationDelegate {
    let options:Options;let log:JSONLog;var ui:StatusUI?;var task:Task<Void,Never>?
    init(_ options:Options,_ log:JSONLog) { self.options=options;self.log=log }
    func applicationDidFinishLaunching(_ notification:Notification) {
        if options.appStatus { ui=StatusUI(logPath:options.output!) }
        task=Task { await DockLive.run(options:options,log:log,ui:ui) }
    }
    func applicationShouldTerminate(_ sender:NSApplication)->NSApplication.TerminateReply {
        if let ui { ui.requestedQuit=true;return .terminateCancel }
        return .terminateNow
    }
}
@main struct DockLive {
    @MainActor static func main() {
        mach_timebase_info(&timebase)
        let options=Options.parse()
        // Arm before any log write or AppKit initialization: stdout may already be full.
        // _exit must not wait for logging locks, blocked writes, async cleanup or UI.
        DispatchQueue.global().asyncAfter(deadline:.now()+options.duration+10) { _exit(124) }
        let log=JSONLog(options.output)
        if options.appStatus || options.overlay {
            // LaunchServices and AppKit own the real main-thread event loop.
            let app=NSApplication.shared;let lifecycle=NativeLifecycle(options,log)
            app.delegate=lifecycle;app.setActivationPolicy(options.appStatus ? .regular:.accessory)
            withExtendedLifetime(lifecycle) { app.run() }
        } else {
            Task { await run(options:options,log:log,ui:nil) }
            dispatchMain()
        }
    }
    @MainActor static func run(options:Options,log:JSONLog,ui:StatusUI?) async {
        let start=mach_absolute_time()
        log.emit(["type":"environment","os":ProcessInfo.processInfo.operatingSystemVersionString,"bundleID":Bundle.main.bundleIdentifier as Any? ?? NSNull(),"bundlePath":Bundle.main.bundlePath,"executable":CommandLine.arguments[0],"processID":ProcessInfo.processInfo.processIdentifier,"parentPID":getppid(),"appStatus":options.appStatus,"overlayRequested":options.overlay,"orientation":options.orientation,"idleCurrentPolicy":options.idleCurrent,"callbackTimeoutSeconds":options.callbackTimeout,"schedulingPolicy":"one_worker_plus_latest_complete_slot","outputLocalPath":options.output as Any? ?? NSNull(),"buildMode":"optimized_-O","scenario":options.scenario,"scenarioIsOperatorLabelOnly":true,"machTimebaseNumer":timebase.numer,"machTimebaseDenom":timebase.denom,"permissionScope":"This launch identity only; CLI host and LaunchServices app are separate experiments","supportEdge":NSNull()])
        guard CGPreflightScreenCaptureAccess() else {
            log.emit(["type":"unavailable","status":"permission_unavailable","shareableContentQueryAttempted":false,"supportEdge":NSNull()])
            ui?.update("BLOCKED: no existing screen-recording grant.\nNo request made. Grant manually only if desired, then relaunch.",options.output ?? "stdout")
            if let ui { while age(mach_absolute_time(),start)<options.duration && !ui.requestedQuit { try? await Task.sleep(nanoseconds:100_000_000) } }
            log.emit(["type":"summary","status":"permission_unavailable","supportEdge":NSNull()]);exit(2)
        }
        var stream:SCStream?;var receiver:Receiver?
        var outcome="completed"
        do {
            let content=try await SCShareableContent.excludingDesktopWindows(true,onScreenWindowsOnly:false)
            let display=CGMainDisplayID()
            guard let screen=NSScreen.screens.first(where:{($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value==display}),display != 0 else { throw NSError(domain:"MoseyDesktopUnavailable",code:1) }
            let primary=CGDisplayBounds(display)
            let initialFrame=screen.frame,initialScale=screen.backingScaleFactor
            let docks=content.windows.filter { $0.owningApplication?.bundleIdentifier=="com.apple.dock" }
            let candidates=docks.filter { abs($0.frame.minX-primary.minX)<1 && abs($0.frame.minY-primary.minY)<1 && abs($0.frame.width-primary.width)<1 && abs($0.frame.height-primary.height)<1 && $0.windowLayer==20 }
            log.emit(["type":"dock_windows","windows":docks.map { ["windowID":$0.windowID,"frame":rectangle($0.frame),"isOnScreen":$0.isOnScreen,"layer":$0.windowLayer] as [String:Any] },"primaryDisplayID":display,"supportEdge":NSNull()])
            let selected=options.windowID.flatMap { id in docks.first { $0.windowID==id } } ?? (options.windowID==nil && candidates.count==1 ? candidates.first : nil)
            guard let selected else { throw NSError(domain:"MoseyNoUniqueDockHost",code:2) }
            let filter=SCContentFilter(desktopIndependentWindow:selected)
            let width=Int((initialFrame.width*initialScale).rounded()),height=Int((initialFrame.height*initialScale).rounded())
            guard width>0,height>0,width*height<=50_000_000,
                  abs(filter.contentRect.width-primary.width)<1,abs(filter.contentRect.height-primary.height)<1,
                  abs(selected.frame.minX-primary.minX)<1,abs(selected.frame.minY-primary.minY)<1,Double(filter.pointPixelScale)==initialScale else { throw NSError(domain:"MoseyUnreliableMapping",code:3) }
            let sink=Receiver(log,options,start);sink.expectedWidth=width;sink.expectedHeight=height;sink.expectedScale=initialScale;receiver=sink
            let config=SCStreamConfiguration();config.width=width;config.height=height
            config.pixelFormat=kCVPixelFormatType_32BGRA;config.shouldBeOpaque=false;config.backgroundColor=sink.clearBackground
            config.showsCursor=false;config.capturesAudio=false;config.queueDepth=3;config.captureDynamicRange = .SDR
            config.ignoreShadowsSingleWindow=true;config.ignoreGlobalClipSingleWindow=false;config.scalesToFit=false;config.preservesAspectRatio=true
            config.minimumFrameInterval=CMTime(seconds:options.interval,preferredTimescale:600)
            let capture=SCStream(filter:filter,configuration:config,delegate:sink);stream=capture
            try capture.addStreamOutput(sink,type:.screen,sampleHandlerQueue:DispatchQueue(label:"mosey.dock.callback",qos:.userInitiated))
            log.emit(["type":"stream_configuration","windowID":selected.windowID,"windowIsOnScreenDiagnosticOnly":selected.isOnScreen,"independentWindowFilter":true,"filterContentRectPoints":rectangle(filter.contentRect),"filterPointPixelScale":filter.pointPixelScale,"rasterWidth":width,"rasterHeight":height,"primaryFrameAppKitPoints":rectangle(initialFrame),"primaryBoundsCGPoints":rectangle(primary),"backingScale":initialScale,"pixelFormat":"BGRA","shouldBeOpaque":false,"backgroundAlpha":0,"queueDepth":3,"requestedMinimumFrameIntervalSeconds":options.interval,"diagnosticMaxFrameAgeSeconds":options.maxAge,"idleCurrentPolicy":options.idleCurrent,"callbackTimeoutSeconds":options.callbackTimeout,"localIntervalGate":false,"schedulingPolicy":"one_worker_plus_latest_complete_slot","alphaThreshold":options.threshold,"coordinateSpace":"Raster pixels top-left; primary-local points divide by backingScale; candidate contour remains unverified","supportEdge":NSNull()])
            let outline=options.overlay ? LiveContour(initialFrame,initialScale,options.orientation):nil
            defer { outline?.update(nil) }
            try await capture.startCapture()
            ui?.update("CAPTURING: isolated Dock alpha statistics only.\nNo pixel files, audio or uploads.",options.output ?? "stdout")
            let runStart=mach_absolute_time()
            while age(mach_absolute_time(),runStart)<options.duration && !(ui?.requestedQuit ?? false) {
                try? await Task.sleep(nanoseconds:UInt64(min(options.interval,0.5)*1_000_000_000))
                if !CGPreflightScreenCaptureAccess() { sink.invalidate("permission_lost");outcome="permission_lost";break }
                guard let current=NSScreen.screens.first(where:{($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value==display}),CGMainDisplayID()==display,current.frame==initialFrame,current.backingScaleFactor==initialScale else { sink.invalidate("display_configuration_changed");outcome="display_configuration_changed";break }
                outline?.update(sink.overlayContour())
                var heartbeat=sink.snapshot();heartbeat["type"]="heartbeat";heartbeat["elapsed"]=age(mach_absolute_time(),start);log.emit(heartbeat)
                if heartbeat["streamErrorCode"] as? Int != nil { outcome="stream_error";break }
            }
            sink.stop()
            try await capture.stopCapture()
            await withCheckedContinuation { continuation in sink.worker.async { continuation.resume() } }
        } catch {
            outcome="native_error"
            receiver?.invalidate(outcome)
            log.emit(["type":"unavailable","status":outcome,"errorDomain":(error as NSError).domain,"errorCode":(error as NSError).code,"supportEdge":NSNull()])
            if let stream { try? await stream.stopCapture() }
        }
        var summary=receiver?.snapshot() ?? [:];summary["type"]="summary";summary["status"]=outcome;summary["elapsed"]=age(mach_absolute_time(),start);summary["productFeasibility"]="unverified";summary["supportEdge"]=NSNull();log.emit(summary)
        ui?.update("STOPPED: \(outcome).\nStatistics remain diagnostic; no product collision edge accepted.",options.output ?? "stdout")
        if let ui {
            let stoppedAt=mach_absolute_time()
            while (age(mach_absolute_time(),start)<options.duration || age(mach_absolute_time(),stoppedAt)<2) && !ui.requestedQuit { try? await Task.sleep(nanoseconds:100_000_000) }
        }
        exit(outcome=="completed" ? 0:2)
    }
}
