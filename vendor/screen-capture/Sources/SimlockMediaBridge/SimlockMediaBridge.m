#import "SimlockMediaBridge.h"
#import <dlfcn.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <arpa/inet.h>
#import <netinet/in.h>
#import <poll.h>
#import <sys/socket.h>
#import <unistd.h>

// Two things happen here that a Swift file cannot do: reach AVConference's negotiator through the
// runtime, and override what that negotiator advertises about HEVC without touching a system
// framework. Both affect this process only.

@interface NSObject (SimlockAVCMediaStreamNegotiator)
- (instancetype)initWithMode:(NSInteger)mode options:(NSDictionary *)options error:(NSError **)error;
- (id)offer;
- (BOOL)setAnswer:(NSData *)answer withError:(NSError **)error;
- (id)generateMediaStreamConfigurationWithError:(NSError **)error;
- (id)dictionary;
@end

// Payload 100 is HEVC. DeviceHub advertises `FLS;VRAE:0;SW:1;` for it, and the idevice receiver
// documents torn pictures with that preset and advertises the string below for its standalone HEVC
// decoder instead. Only payload 100 is replaced; H.264 and every other part of the offer goes out as
// the framework built it. The string is from the MIT-licensed idevice project (see NOTICE.md).
static NSString *const kSimlockStandaloneHEVCFeatures =
    @"FLS;MS:-1;LF:-1;LTR;CABAC;POS:0;EOD:1;HTS:2;RR:3;AR:16/9,5/8;XR:16/9,5/8;";

static IMP simlockOriginalScreenFeatures;

static NSDictionary *simlockScreenDecoderFeatures(id self, SEL selector) {
    NSDictionary *original =
        ((NSDictionary *(*)(id, SEL))simlockOriginalScreenFeatures)(self, selector);
    NSMutableDictionary *features = [original mutableCopy];
    if (features[@100]) {
        features[@100] = kSimlockStandaloneHEVCFeatures;
    }
    return features;
}

static BOOL simlockLTRPDisabled(id self, SEL selector) {
    return NO;
}

static void simlockDisableLTRPGetter(NSString *className) {
    Method getter = class_getInstanceMethod(
        NSClassFromString(className), @selector(ltrpEnabled));
    if (getter == NULL) {
        NSLog(@"negotiator: %@ has no ltrpEnabled", className);
        return;
    }
    method_setImplementation(getter, (IMP)simlockLTRPDisabled);
}

// why: the offer is built inside -initWithMode:options:error: out of the settings preset and the
// local configuration, so both getters are overridden before the negotiator exists — and only for
// this process, which is the difference between this and modifying a system framework.
static BOOL simlockInstallNegotiatorHooks(void) {
    static dispatch_once_t once;
    __block BOOL installed = NO;
    dispatch_once(&once, ^{
        Class settings =
            NSClassFromString(@"AVCMediaStreamNegotiatorSettingsCoreDeviceScreenSharing");
        Method features = class_getInstanceMethod(settings, @selector(featureListString));
        if (features == NULL) {
            NSLog(@"negotiator: HEVC capability setting unavailable");
            return;
        }
        simlockOriginalScreenFeatures = method_setImplementation(features, (IMP)simlockScreenDecoderFeatures);
        installed = YES;
        NSLog(@"negotiator: standalone-decoder HEVC capabilities enabled");
        simlockDisableLTRPGetter(@"AVCMediaStreamNegotiatorSettings");
        simlockDisableLTRPGetter(@"VCMediaNegotiatorLocalConfiguration");
        NSLog(@"negotiator: LTRP disabled for the offer");
    });
    return installed;
}

NSObject *simlockNegotiator(NSDictionary *options, NSInteger mode) {
    dlopen("/System/Library/PrivateFrameworks/AVConference.framework/AVConference", RTLD_NOW);
    if (!simlockInstallNegotiatorHooks()) {
        return nil;
    }
    Class negotiatorClass = NSClassFromString(@"AVCMediaStreamNegotiator");
    if (negotiatorClass == nil) {
        NSLog(@"negotiator: AVCMediaStreamNegotiator is not present");
        return nil;
    }
    NSError *error = nil;
    id negotiator = [(id)[negotiatorClass alloc] initWithMode:mode options:options error:&error];
    if (error != nil) {
        NSLog(@"negotiator error: %@", error);
    }
    return negotiator;
}

NSData *simlockOffer(NSObject *negotiator) {
    id offer = [negotiator offer];
    return [offer isKindOfClass:NSData.class] ? offer : nil;
}

NSDictionary *simlockAnswer(NSObject *negotiator, NSData *answer) {
    NSError *error = nil;
    if (![negotiator setAnswer:answer withError:&error]) {
        NSLog(@"answer error: %@", error);
        return nil;
    }
    id configuration = [negotiator generateMediaStreamConfigurationWithError:&error];
    if (error != nil) {
        NSLog(@"configuration error: %@", error);
        return nil;
    }
    id dictionary = [configuration dictionary];
    return [dictionary isKindOfClass:NSDictionary.class] ? dictionary : nil;
}

// MARK: - The receiver socket

// One socket receives at a time, and the one bound for the tunnel route is not it for long: that one
// exists to name the address and port `startMediaStream` is asked to send to, so it is put down once
// the stream has answered and `simlockAdopt` gives the receiver to the socket CoreDevice shares for the
// stream. `send` on a socket that was bound but never connected fails with EDESTADDRREQ, so while the
// reserved-port socket held the receiver every RTCP report, key-frame request and bye went nowhere.
static int simlockReceiverFd = -1;
static uint16_t simlockReceiverBoundPort = 0;

// The iPhone sends to the host's own address on the tunnel's route, so that address is asked of the
// routing table rather than written down: a tunnel address is per-pairing and per-transport.
NSString *simlockBindForTunnel(NSString *tunnelIPAddress) {
    int route = socket(AF_INET6, SOCK_DGRAM, 0);
    struct sockaddr_in6 destination = {0};
    struct sockaddr_in6 source = {0};
    destination.sin6_len = sizeof(destination);
    destination.sin6_family = AF_INET6;
    destination.sin6_port = htons(9);
    if (inet_pton(AF_INET6, tunnelIPAddress.UTF8String, &destination.sin6_addr) != 1) {
        close(route);
        return nil;
    }
    if (connect(route, (struct sockaddr *)&destination, sizeof(destination)) != 0) {
        close(route);
        return nil;
    }
    socklen_t length = sizeof(source);
    getsockname(route, (struct sockaddr *)&source, &length);
    close(route);

    char address[INET6_ADDRSTRLEN];
    inet_ntop(AF_INET6, &source.sin6_addr, address, sizeof(address));

    simlockReceiverFd = socket(AF_INET6, SOCK_DGRAM, 0);
    source.sin6_port = 0;
    if (bind(simlockReceiverFd, (struct sockaddr *)&source, sizeof(source)) != 0) {
        simlockCloseReceiver();
        return nil;
    }
    length = sizeof(source);
    getsockname(simlockReceiverFd, (struct sockaddr *)&source, &length);
    simlockReceiverBoundPort = ntohs(source.sin6_port);
    int bufferSize = 4 * 1024 * 1024;
    setsockopt(simlockReceiverFd, SOL_SOCKET, SO_RCVBUF, &bufferSize, sizeof(bufferSize));
    return @(address);
}

uint16_t simlockReceiverPort(void) {
    return simlockReceiverBoundPort;
}

void simlockReleaseBoundSocket(void) {
    if (simlockReceiverFd < 0) {
        return;
    }
    close(simlockReceiverFd);
    simlockReceiverFd = -1;
}

NSData *simlockReceive(int milliseconds) {
    if (simlockReceiverFd < 0) {
        return nil;
    }
    struct pollfd waiter = {simlockReceiverFd, POLLIN, 0};
    if (poll(&waiter, 1, milliseconds) <= 0) {
        return nil;
    }
    unsigned char buffer[65536];
    ssize_t received = recv(simlockReceiverFd, buffer, sizeof(buffer), 0);
    return received > 0 ? [NSData dataWithBytes:buffer length:(NSUInteger)received] : nil;
}

BOOL simlockSend(NSData *packet) {
    if (simlockReceiverFd < 0) {
        return NO;
    }
    return send(simlockReceiverFd, packet.bytes, packet.length, 0) == (ssize_t)packet.length;
}

BOOL simlockAdopt(xpc_object_t sockets) {
    xpc_dictionary_apply(sockets, ^bool(const char *key, xpc_object_t value) {
        if (xpc_get_type(value) != XPC_TYPE_FD) {
            return true;
        }
        int descriptor = xpc_fd_dup(value);
        if (simlockReceiverFd < 0) {
            simlockReceiverFd = descriptor;
            int bufferSize = 4 * 1024 * 1024;
            setsockopt(simlockReceiverFd, SOL_SOCKET, SO_RCVBUF, &bufferSize, sizeof(bufferSize));
        } else {
            close(descriptor);
        }
        return true;
    });
    return simlockReceiverFd >= 0;
}

void simlockCloseReceiver(void) {
    if (simlockReceiverFd >= 0) {
        close(simlockReceiverFd);
        simlockReceiverFd = -1;
    }
}
